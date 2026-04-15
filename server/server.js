import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { randomInt, randomUUID } from "crypto";
import {
  ChimeSDKMeetingsClient,
  CreateMeetingWithAttendeesCommand,
} from "@aws-sdk/client-chime-sdk-meetings";

dotenv.config();

const app = express();
const allowedOrigins = process.env.CORS_ORIGIN
  ? [process.env.CORS_ORIGIN]
  : ["http://localhost:5173", "http://127.0.0.1:5173"];
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Not allowed by CORS"));
    },
  })
);
app.use(express.json());

const region = process.env.AWS_REGION || "us-east-1";
const client = new ChimeSDKMeetingsClient({ region });
const port = process.env.PORT || 4000;

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/** Short codes guests type in (no 0/O / 1/I confusion). */
const ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeRoomCode() {
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += ROOM_CHARS[randomInt(ROOM_CHARS.length)];
  }
  return code;
}

/** roomCode -> { meeting, doctor, patient } */
const rooms = new Map();

/** roomCode -> [{ speaker, text, at }] */
const transcripts = new Map();

function normalizeRoomCode(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function summarizeTranscriptWithOpenAI(transcriptText) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    const err = new Error("OPENAI_API_KEY is not set on the server");
    err.code = "NO_OPENAI";
    throw err;
  }
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: `You are a clinical documentation assistant. Given a telehealth visit transcript labeled by speaker (Clinician vs Patient), write a concise outpatient-style medical note for the chart. Use professional clinical language. Include only what the transcript supports; if information is missing, say so briefly. Use clear sections: Chief complaint / HPI, Review of systems (as discussed), Assessment, Plan. End with a one-line disclaimer that the note was drafted from an automated transcript and must be reviewed by the clinician.`,
        },
        {
          role: "user",
          content: `Visit transcript:\n\n${transcriptText}`,
        },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText || "OpenAI request failed";
    const err = new Error(msg);
    err.details = data;
    throw err;
  }
  return data.choices?.[0]?.message?.content?.trim() || "";
}

/** Doctor starts a visit: create Chime room and return a shareable meeting ID. */
app.post("/api/meeting", async (req, res) => {
  try {
    let roomCode = makeRoomCode();
    while (rooms.has(roomCode)) {
      roomCode = makeRoomCode();
    }

    const response = await client.send(
      new CreateMeetingWithAttendeesCommand({
        ClientRequestToken: randomUUID(),
        ExternalMeetingId: `visit-${roomCode}`.slice(0, 64),
        MediaRegion: region,
        Attendees: [
          { ExternalUserId: `doctor-${randomUUID()}`.slice(0, 64) },
          { ExternalUserId: `patient-${randomUUID()}`.slice(0, 64) },
        ],
      })
    );

    const doctor = response.Attendees[0];
    const patient = response.Attendees[1];

    rooms.set(roomCode, {
      meeting: response.Meeting,
      doctor,
      patient,
    });

    res.json({
      roomCode,
      meeting: response.Meeting,
      attendee: doctor,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

/** Guest joins with the meeting ID the host shared. */
app.post("/api/meeting/join", (req, res) => {
  const raw = req.body?.roomCode;
  if (typeof raw !== "string" || !raw.trim()) {
    return res.status(400).json({ error: "Meeting ID is required" });
  }
  const roomCode = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const room = rooms.get(roomCode);
  if (!room) {
    return res.status(404).json({ error: "No meeting found for that ID" });
  }

  res.json({
    roomCode,
    meeting: room.meeting,
    attendee: room.patient,
  });
});

/** Append a line to the visit transcript (from browser speech recognition per participant). */
app.post("/api/transcript", (req, res) => {
  const roomCode = normalizeRoomCode(req.body?.roomCode);
  const speaker = req.body?.speaker;
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!roomCode || !rooms.has(roomCode)) {
    return res.status(404).json({ error: "Unknown meeting ID" });
  }
  if (speaker !== "doctor" && speaker !== "patient") {
    return res.status(400).json({ error: "speaker must be doctor or patient" });
  }
  if (!text) {
    return res.status(400).json({ error: "text is required" });
  }
  if (!transcripts.has(roomCode)) {
    transcripts.set(roomCode, []);
  }
  transcripts.get(roomCode).push({
    speaker,
    text,
    at: Date.now(),
  });
  res.json({ ok: true });
});

/** Full transcript for a visit (for display and summarization). */
app.get("/api/meeting/:roomCode/transcript", (req, res) => {
  const roomCode = normalizeRoomCode(req.params.roomCode);
  if (!roomCode) {
    return res.status(400).json({ error: "Invalid meeting ID" });
  }
  const lines = transcripts.get(roomCode) ?? [];
  res.json({ roomCode, lines });
});

/** Generate a draft medical note from the transcript (requires OPENAI_API_KEY). */
app.post("/api/meeting/:roomCode/summarize", async (req, res) => {
  const roomCode = normalizeRoomCode(req.params.roomCode);
  if (!roomCode || !rooms.has(roomCode)) {
    return res.status(404).json({ error: "Unknown meeting ID" });
  }
  const lines = transcripts.get(roomCode) ?? [];
  if (lines.length === 0) {
    return res.status(400).json({
      error: "No transcript lines yet. Speak during the call with transcription enabled.",
    });
  }
  const transcriptText = lines
    .map((l) => {
      const label = l.speaker === "doctor" ? "Clinician" : "Patient";
      return `${label}: ${l.text}`;
    })
    .join("\n");
  try {
    const note = await summarizeTranscriptWithOpenAI(transcriptText);
    res.json({ roomCode, note, lineCount: lines.length });
  } catch (e) {
    if (e.code === "NO_OPENAI") {
      return res.status(503).json({
        error:
          "Summaries require OPENAI_API_KEY in server/.env. Add your key and restart the server.",
      });
    }
    console.error(e);
    res.status(500).json({ error: e.message || "Summarization failed" });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});