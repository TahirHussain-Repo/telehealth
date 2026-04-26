import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { randomInt, randomUUID } from "crypto";
import { createServer } from "http";
import { WebSocketServer } from "ws";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 4000;
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

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

/** roomCode -> { roomCode, doctorParticipantId, participants: Set<string>, knocks: Map } */
const rooms = new Map();

/** roomCode -> [{ speaker, text, at }] */
const transcripts = new Map();

/** knockId -> { knockId, roomCode, status: 'pending'|'admitted'|'denied', participantId } */
const knocks = new Map();

/** participantId -> ws */
const socketsByParticipant = new Map();

/** participantId -> roomCode */
const roomByParticipant = new Map();

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function broadcastToRoom(roomCode, payload, exceptParticipantId = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const participantId of room.participants) {
    if (participantId === exceptParticipantId) continue;
    const ws = socketsByParticipant.get(participantId);
    safeSend(ws, payload);
  }
}

function attachParticipantToRoom({ participantId, roomCode, role }) {
  const room = rooms.get(roomCode);
  if (!room) return null;

  const hasAdmittedKnock = [...room.knocks.values()].some(
    (k) => k.participantId === participantId && k.status === "admitted"
  );
  const allowed =
    (role === "doctor" && participantId === room.doctorParticipantId) ||
    (role === "patient" && hasAdmittedKnock);
  if (!allowed) return null;

  room.participants.add(participantId);
  return room;
}

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const roomCode = normalizeRoomCode(url.searchParams.get("roomCode"));
    const participantId = url.searchParams.get("participantId");
    const role = url.searchParams.get("role");

    if (!roomCode || !participantId || (role !== "doctor" && role !== "patient")) {
      ws.close(1008, "Invalid websocket params");
      return;
    }

    const room = attachParticipantToRoom({ participantId, roomCode, role });
    if (!room) {
      ws.close(1008, "Not admitted to room");
      return;
    }

    socketsByParticipant.set(participantId, ws);
    roomByParticipant.set(participantId, roomCode);

    const peers = [...room.participants].filter((id) => id !== participantId);
    safeSend(ws, { type: "peers", peers });
    broadcastToRoom(roomCode, { type: "peer-joined", peerId: participantId }, participantId);

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg?.type === "signal" && typeof msg?.to === "string" && msg?.data) {
        const target = socketsByParticipant.get(msg.to);
        safeSend(target, {
          type: "signal",
          from: participantId,
          data: msg.data,
        });
      }
    });

    ws.on("close", () => {
      const rc = roomByParticipant.get(participantId);
      socketsByParticipant.delete(participantId);
      roomByParticipant.delete(participantId);
      const r = rc ? rooms.get(rc) : null;
      if (r) {
        r.participants.delete(participantId);
        broadcastToRoom(rc, { type: "peer-left", peerId: participantId }, participantId);
      }
    });
  } catch {
    ws.close(1011, "Server error");
  }
});

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

/** Doctor starts a visit: create room metadata and return a shareable meeting ID. */
app.post("/api/meeting", async (req, res) => {
  try {
    let roomCode = makeRoomCode();
    while (rooms.has(roomCode)) {
      roomCode = makeRoomCode();
    }
    const doctorParticipantId = `doctor-${randomUUID()}`;

    rooms.set(roomCode, {
      roomCode,
      doctorParticipantId,
      participants: new Set(),
      knocks: new Map(),
    });

    res.json({
      roomCode,
      participantId: doctorParticipantId,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
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

// ── Waiting room / knock flow ─────────────────────────────────────────────

/** Patient knocks — enters the waiting room for this meeting. */
app.post("/api/meeting/knock", async (req, res) => {
  const roomCode = normalizeRoomCode(req.body?.roomCode);
  const room = rooms.get(roomCode);
  if (!room) {
    return res.status(404).json({ error: "No meeting found for that ID" });
  }

  const knockId = randomUUID();
  const participantId = `patient-${randomUUID()}`;
  const entry = { knockId, roomCode, status: "pending", participantId };
  knocks.set(knockId, entry);
  room.knocks.set(knockId, entry);
  res.json({ knockId });
});

/** Patient polls this to find out if they have been admitted or denied. */
app.get("/api/meeting/knock/:knockId", (req, res) => {
  const entry = knocks.get(req.params.knockId);
  if (!entry) return res.status(404).json({ error: "Knock not found" });

  if (entry.status === "admitted") {
    return res.json({
      status: "admitted",
      participantId: entry.participantId,
      roomCode: entry.roomCode,
    });
  }

  res.json({ status: entry.status });
});

/** Doctor polls to see who is waiting. */
app.get("/api/meeting/:roomCode/knocks", (req, res) => {
  const roomCode = normalizeRoomCode(req.params.roomCode);
  if (!rooms.has(roomCode)) {
    return res.status(404).json({ error: "Unknown meeting ID" });
  }
  const room = rooms.get(roomCode);
  const pending = room.knocks
    ? [...room.knocks.values()]
        .filter((k) => k.status === "pending")
        .map((k) => ({ knockId: k.knockId }))
    : [];
  res.json({ knocks: pending });
});

/** Doctor admits a patient from the waiting room. */
app.post("/api/meeting/:roomCode/admit/:knockId", (req, res) => {
  const roomCode = normalizeRoomCode(req.params.roomCode);
  const entry = knocks.get(req.params.knockId);
  if (!entry || entry.roomCode !== roomCode) {
    return res.status(404).json({ error: "Knock not found" });
  }
  entry.status = "admitted";
  res.json({ ok: true });
});

/** Doctor denies a patient from the waiting room. */
app.post("/api/meeting/:roomCode/deny/:knockId", (req, res) => {
  const roomCode = normalizeRoomCode(req.params.roomCode);
  const entry = knocks.get(req.params.knockId);
  if (!entry || entry.roomCode !== roomCode) {
    return res.status(404).json({ error: "Knock not found" });
  }
  entry.status = "denied";
  res.json({ ok: true });
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});