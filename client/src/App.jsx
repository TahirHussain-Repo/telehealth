import { useEffect, useMemo, useRef, useState } from "react";
import {
  ConsoleLogger,
  DefaultDeviceController,
  DefaultMeetingSession,
  LogLevel,
  MeetingSessionConfiguration,
} from "amazon-chime-sdk-js";
import "./App.css";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

function displayNameFromExternal(ext) {
  if (!ext) return "Participant";
  if (ext.startsWith("doctor-")) return "Clinician";
  if (ext.startsWith("patient-")) return "Patient";
  return "Participant";
}

function initialsFromDisplayName(name) {
  const parts = name.replace(/\s*\(you\)\s*/i, "").trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return (parts[0]?.[0] ?? "?").toUpperCase();
}

/** Tile has video we can bind (Chime may set `active` loosely; prefer !paused). */
function tileShowsCamera(tile) {
  if (!tile?.tileId) return false;
  if (tile.paused) return false;
  return true;
}

/**
 * Mounts a <video> element and binds it to a Chime tile.
 * Using a dedicated component ensures bindVideoElement is called exactly once
 * per mount, and unbindVideoElement is called on unmount — no race conditions.
 */
function VideoTile({ tileId, localTile, session, label, paused }) {
  const videoRef = useRef(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !session) return undefined;
    try {
      session.audioVideo.bindVideoElement(tileId, el);
    } catch (err) {
      console.warn("bindVideoElement failed:", err);
    }
    return () => {
      try {
        session.audioVideo.unbindVideoElement(tileId);
      } catch {
        /* noop */
      }
    };
  }, [tileId, session]);

  return (
    <div className="video-tile-wrap video-tile-wrap--live">
      <video ref={videoRef} autoPlay playsInline muted={Boolean(localTile)} />
      <div className="video-tile-label">
        {label}
        {paused ? " · Paused" : ""}
      </div>
    </div>
  );
}

export default function App() {
  const [hostPayload, setHostPayload] = useState(null);
  const [guestCode, setGuestCode] = useState("");
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);

  const [mediaConnected, setMediaConnected] = useState(false);
  /** Roster synced from Chime presence (both browsers see the same list). */
  const [participants, setParticipants] = useState([]);
  /** tileId -> tile info for gallery binding */
  const [videoTiles, setVideoTiles] = useState({});
  const [visitContext, setVisitContext] = useState(null);
  const [transcriptLines, setTranscriptLines] = useState([]);
  const [medicalNote, setMedicalNote] = useState(null);
  const [summarizing, setSummarizing] = useState(false);
  const [sttError, setSttError] = useState(null);
  /** Lets the patient keep viewing transcript / note after leaving the call. */
  const [guestRoomAfterLeave, setGuestRoomAfterLeave] = useState(null);

  /** Single-device testing: which role the mic is attributed to in the transcript. */
  const [transcriptMicAs, setTranscriptMicAs] = useState("doctor");
  const transcriptMicAsRef = useRef("doctor");
  const [micMuted, setMicMuted] = useState(false);
  const [localCamOn, setLocalCamOn] = useState(true);

  const rosterRef = useRef(new Map());
  const audioElRef = useRef(null);

  const transcriptRoomCode =
    visitContext?.roomCode ??
    hostPayload?.roomCode ??
    guestRoomAfterLeave ??
    null;

  const connectChime = async (meeting, attendee, meta) => {
    rosterRef.current = new Map();
    setParticipants([]);
    setVideoTiles({});
    setMediaConnected(false);
    setSttError(null);
    setLocalCamOn(true);

    const logger = new ConsoleLogger("ChimeLogs", LogLevel.INFO);
    const deviceController = new DefaultDeviceController(logger);
    const config = new MeetingSessionConfiguration(meeting, attendee);

    const meetingSession = new DefaultMeetingSession(
      config,
      logger,
      deviceController
    );

    const myId = attendee.AttendeeId;

    const syncRosterToState = () => {
      const localLabel = meta.role === "doctor" ? "Clinician" : "Patient";
      const remotes = [...rosterRef.current.entries()].map(([id, data]) => ({
        attendeeId: id,
        displayName: displayNameFromExternal(data.externalUserId),
        isSelf: false,
      }));
      remotes.sort((a, b) => a.displayName.localeCompare(b.displayName));
      setParticipants([
        {
          attendeeId: myId,
          displayName: `${localLabel} (you)`,
          isSelf: true,
        },
        ...remotes,
      ]);
    };

    meetingSession.audioVideo.addObserver({
      audioVideoDidStart: () => setMediaConnected(true),
      audioVideoDidStop: () => {
        setMediaConnected(false);
        rosterRef.current = new Map();
        setParticipants([]);
        setVideoTiles({});
      },
      videoTileDidUpdate: (tileState) => {
        if (!tileState.tileId || tileState.isContent) return;
        if (!tileState.boundAttendeeId) {
          setVideoTiles((prev) => {
            const next = { ...prev };
            delete next[tileState.tileId];
            return next;
          });
          return;
        }
        setVideoTiles((prev) => ({
          ...prev,
          [tileState.tileId]: {
            tileId: tileState.tileId,
            attendeeId: tileState.boundAttendeeId,
            externalUserId: tileState.boundExternalUserId,
            localTile: tileState.localTile,
            active: tileState.active,
            paused: tileState.paused,
          },
        }));
      },
      videoTileWasRemoved: (tileId) => {
        setVideoTiles((prev) => {
          const next = { ...prev };
          delete next[tileId];
          return next;
        });
      },
    });

    meetingSession.audioVideo.realtimeSubscribeToAttendeeIdPresence(
      (attendeeId, present, externalUserId) => {
        if (attendeeId === myId) return;
        if (present) {
          rosterRef.current.set(attendeeId, {
            externalUserId: externalUserId || "",
          });
        } else {
          rosterRef.current.delete(attendeeId);
        }
        syncRosterToState();
      }
    );

    // Always pass a deviceId — fall back to "default" so we never silently
    // skip audio/video even when enumerate returns an empty list (e.g. before
    // the browser permission prompt resolves).
    const audioInputs = await meetingSession.audioVideo.listAudioInputDevices();
    const audioDeviceId = audioInputs[0]?.deviceId ?? "default";
    await meetingSession.audioVideo.startAudioInput(audioDeviceId);

    const videoInputs = await meetingSession.audioVideo.listVideoInputDevices();
    if (videoInputs.length > 0) {
      await meetingSession.audioVideo.startVideoInput(videoInputs[0].deviceId);
    }

    // Bind the audio output element BEFORE start() so remote audio plays
    // immediately once the session connects.
    if (audioElRef.current) {
      await meetingSession.audioVideo.bindAudioElement(audioElRef.current);
    }

    meetingSession.audioVideo.start();
    meetingSession.audioVideo.startLocalVideoTile();

    meetingSession.audioVideo.realtimeSubscribeToMuteAndUnmuteLocalAudio(
      (muted) => {
        setMicMuted(muted);
      }
    );
    setMicMuted(meetingSession.audioVideo.realtimeIsLocalAudioMuted());

    syncRosterToState();
    const role = meta.role === "doctor" ? "doctor" : "patient";
    setTranscriptMicAs(role);
    transcriptMicAsRef.current = role;
    setVisitContext({ roomCode: meta.roomCode, role: meta.role });
    setSession(meetingSession);
  };

  const startVisitAsDoctor = async () => {
    setBusy(true);
    setMedicalNote(null);
    setGuestRoomAfterLeave(null);
    try {
      const res = await fetch(`${API_URL}/api/meeting`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start visit");
      setHostPayload({
        roomCode: data.roomCode,
        meeting: data.meeting,
        attendee: data.attendee,
      });
    } catch (e) {
      console.error(e);
      alert(e.message || "Failed to start visit");
    } finally {
      setBusy(false);
    }
  };

  const joinAsHost = async () => {
    if (!hostPayload) return;
    setBusy(true);
    try {
      await connectChime(hostPayload.meeting, hostPayload.attendee, {
        roomCode: hostPayload.roomCode,
        role: "doctor",
      });
    } catch (e) {
      console.error(e);
      alert(e.message || "Could not join call");
    } finally {
      setBusy(false);
    }
  };

  const joinAsGuest = async () => {
    const code = guestCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length < 4) {
      alert("Enter the meeting ID from the host.");
      return;
    }
    setBusy(true);
    setMedicalNote(null);
    setGuestRoomAfterLeave(null);
    try {
      const res = await fetch(`${API_URL}/api/meeting/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomCode: code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not join");
      await connectChime(data.meeting, data.attendee, {
        roomCode: data.roomCode,
        role: "patient",
      });
    } catch (e) {
      console.error(e);
      alert(e.message || "Could not join call");
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    if (visitContext?.role === "patient") {
      setGuestRoomAfterLeave(visitContext.roomCode);
    }
    if (session) {
      session.audioVideo.stopLocalVideoTile();
      session.audioVideo.stop();
      setSession(null);
    }
    setVisitContext(null);
    setMediaConnected(false);
    rosterRef.current = new Map();
    setParticipants([]);
    setVideoTiles({});
    setTranscriptMicAs("doctor");
    transcriptMicAsRef.current = "doctor";
    setMicMuted(false);
    setLocalCamOn(true);
  };

  const toggleMic = () => {
    if (!session) return;
    const av = session.audioVideo;
    if (av.realtimeIsLocalAudioMuted()) {
      av.realtimeUnmuteLocalAudio();
    } else {
      av.realtimeMuteLocalAudio();
    }
  };

  const toggleCamera = () => {
    if (!session) return;
    const av = session.audioVideo;
    if (localCamOn) {
      av.stopLocalVideoTile();
      setLocalCamOn(false);
    } else {
      av.startLocalVideoTile();
      setLocalCamOn(true);
    }
  };

  useEffect(() => {
    transcriptMicAsRef.current = transcriptMicAs;
  }, [transcriptMicAs]);

  useEffect(() => {
    if (!visitContext?.roomCode) return undefined;

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSttError(
        "This browser does not support speech-to-text. Use Chrome or Edge on desktop for live transcription."
      );
      return undefined;
    }

    const rec = new SpeechRecognition();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    let stopped = false;

    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (!event.results[i].isFinal) continue;
        const text = event.results[i][0].transcript.trim();
        if (!text) continue;
        fetch(`${API_URL}/api/transcript`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            roomCode: visitContext.roomCode,
            speaker: transcriptMicAsRef.current,
            text,
          }),
        }).catch((err) => console.error("transcript post", err));
      }
    };

    rec.onerror = (ev) => {
      if (ev.error === "not-allowed") {
        setSttError("Microphone permission denied — transcription needs mic access.");
      } else if (ev.error !== "no-speech" && ev.error !== "aborted") {
        console.warn("SpeechRecognition:", ev.error);
      }
    };

    rec.onend = () => {
      if (!stopped) {
        try {
          rec.start();
        } catch {
          /* ignore */
        }
      }
    };

    try {
      rec.start();
    } catch (e) {
      setSttError(e.message || "Could not start speech recognition");
    }

    return () => {
      stopped = true;
      rec.onend = null;
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    };
  }, [visitContext]);

  useEffect(() => {
    if (!transcriptRoomCode) {
      setTranscriptLines([]);
      return undefined;
    }

    const load = () => {
      fetch(`${API_URL}/api/meeting/${transcriptRoomCode}/transcript`)
        .then((r) => r.json())
        .then((data) => {
          if (Array.isArray(data.lines)) setTranscriptLines(data.lines);
        })
        .catch(console.error);
    };

    load();
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [transcriptRoomCode]);

  const remoteOthersCount = Math.max(0, participants.length - 1);

  const tileByAttendeeId = useMemo(() => {
    const m = new Map();
    for (const t of Object.values(videoTiles)) {
      if (t.attendeeId) m.set(t.attendeeId, t);
    }
    return m;
  }, [videoTiles]);

  const copyRoomCode = async () => {
    if (!hostPayload?.roomCode) return;
    try {
      await navigator.clipboard.writeText(hostPayload.roomCode);
    } catch {
      prompt("Copy this meeting ID:", hostPayload.roomCode);
    }
  };

  const copyMeetingId = async () => {
    const code = transcriptRoomCode;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      prompt("Meeting ID:", code);
    }
  };

  const videoLabelForParticipant = (p) => {
    if (p.isSelf) {
      return visitContext?.role === "doctor"
        ? "Clinician (you)"
        : "Patient (you)";
    }
    return p.displayName;
  };

  const showParticipantVideo = (p) => {
    if (p.isSelf && !localCamOn) return false;
    const tile = tileByAttendeeId.get(p.attendeeId);
    if (!tile) return false;
    return tileShowsCamera(tile);
  };

  const generateNote = async () => {
    const rc = transcriptRoomCode;
    if (!rc) return;
    setSummarizing(true);
    setMedicalNote(null);
    try {
      const res = await fetch(`${API_URL}/api/meeting/${rc}/summarize`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not generate note");
      setMedicalNote(data.note);
    } catch (e) {
      console.error(e);
      alert(e.message || "Summarization failed");
    } finally {
      setSummarizing(false);
    }
  };

  const inCall = Boolean(session);

  const visitRecordInner = (
    <>
      <h2 id="record-heading-title" className="record-heading-inline">
        Visit record
      </h2>
      <p className="record-meta">
        Meeting <code>{transcriptRoomCode}</code>
      </p>

      <div className="transcript-box" aria-live="polite">
        {transcriptLines.length === 0 ? (
          <span className="empty-hint">
            No lines yet—speak during the visit. On one device, use Clinician /
            Patient to label who is talking.
          </span>
        ) : (
          transcriptLines.map((line, i) => (
            <div key={`${line.at}-${i}`} className="transcript-line">
              <span
                className={`who ${line.speaker === "doctor" ? "doc" : "pt"}`}
              >
                {line.speaker === "doctor" ? "Clinician" : "Patient"}:
              </span>
              {line.text}
            </div>
          ))
        )}
      </div>

      <div className="btn-row record-actions">
        <button
          type="button"
          className="primary"
          onClick={generateNote}
          disabled={summarizing || transcriptLines.length === 0}
        >
          {summarizing ? "Generating note…" : "Draft medical note"}
        </button>
      </div>

      {medicalNote && (
        <>
          <h3 className="note-heading">Draft note (for review only)</h3>
          <div className="note-box">{medicalNote}</div>
        </>
      )}
    </>
  );

  return (
    <div className={`app-shell ${inCall ? "app-shell--meeting" : ""}`}>
      {/* Hidden audio sink — Chime routes all remote audio here */}
      <audio ref={audioElRef} autoPlay style={{ display: "none" }} />
      {inCall ? (
        <header className="meeting-topbar">
          <div className="meeting-topbar__left">
            <div className="app-logo app-logo--sm" aria-hidden />
            <div>
              <div className="meeting-topbar__title">Telehealth appointment</div>
              <div className="meeting-topbar__meta">
                <span className="mono-id">{transcriptRoomCode}</span>
                <span className="meeting-topbar__sep">·</span>
                <span>{mediaConnected ? "Connected" : "Connecting…"}</span>
                <span className="meeting-topbar__sep">·</span>
                <span>
                  {remoteOthersCount > 0
                    ? remoteOthersCount === 1
                      ? "1 other participant"
                      : `${remoteOthersCount} other participants`
                    : "Waiting for others"}
                </span>
              </div>
            </div>
          </div>
          <div className="meeting-topbar__right">
            <button
              type="button"
              className="ghost btn-toolbar-text"
              onClick={copyMeetingId}
            >
              Copy ID
            </button>
          </div>
        </header>
      ) : (
        <div className="lobby">
          <header className="lobby-hero">
            <div className="lobby-hero__brand">
              <div className="app-logo" aria-hidden />
              <span className="lobby-eyebrow">Video visit</span>
            </div>
            <h1 className="lobby-title">Telehealth Visit</h1>
            <p className="lobby-lead">
              Join a secure video appointment with your care team. Providers
              start the visit; patients join with the meeting ID.
            </p>
          </header>

          <div className="lobby-grid">
            <section className="lobby-card" aria-labelledby="host-heading">
              <p className="lobby-card__eyebrow">For providers</p>
              <div className="lobby-card__head">
                <div className="role-icon role-icon--host" aria-hidden>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
                    <path d="M4.5 9.5V5.5C4.5 4.39543 5.39543 3.5 6.5 3.5H17.5C18.6046 3.5 19.5 4.39543 19.5 5.5V9.5" />
                    <path d="M8 21.5V17.5C8 16.3954 8.89543 15.5 10 15.5H14C15.1046 15.5 16 16.3954 16 17.5V21.5" />
                    <path d="M12 12.5C13.3807 12.5 14.5 11.3807 14.5 10C14.5 8.61929 13.3807 7.5 12 7.5C10.6193 7.5 9.5 8.61929 9.5 10C9.5 11.3807 10.6193 12.5 12 12.5Z" />
                  </svg>
                </div>
                <div>
                  <h2 id="host-heading">Clinician</h2>
                  <p className="lobby-card__text">
                    Open a new visit room, join as host, then share the meeting
                    ID with your patient.
                  </p>
                </div>
              </div>
              <div className="lobby-card__actions">
                <button
                  type="button"
                  className="primary lobby-btn-main"
                  onClick={startVisitAsDoctor}
                  disabled={busy || inCall}
                >
                  Start new visit
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={joinAsHost}
                  disabled={busy || inCall || !hostPayload}
                >
                  Join as host
                </button>
              </div>

              {hostPayload && (
                <div className="room-banner">
                  <p className="room-label">Active meeting ID</p>
                  <p className="room-code">{hostPayload.roomCode}</p>
                  <button type="button" className="btn-link" onClick={copyRoomCode}>
                    Copy ID
                  </button>
                </div>
              )}
            </section>

            <section className="lobby-card" aria-labelledby="guest-heading">
              <p className="lobby-card__eyebrow">For patients</p>
              <div className="lobby-card__head">
                <div className="role-icon role-icon--guest" aria-hidden>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
                    <path d="M12 11.5C14.2091 11.5 16 9.70914 16 7.5C16 5.29086 14.2091 3.5 12 3.5C9.79086 3.5 8 5.29086 8 7.5C8 9.70914 9.79086 11.5 12 11.5Z" />
                    <path d="M4.5 20.5C4.5 16.634 7.63401 13.5 11.5 13.5H12.5C16.366 13.5 19.5 16.634 19.5 20.5" />
                  </svg>
                </div>
                <div>
                  <h2 id="guest-heading">Patient</h2>
                  <p className="lobby-card__text">
                    Enter the meeting ID you received from your clinician or
                    clinic.
                  </p>
                </div>
              </div>
              <label className="label" htmlFor="meeting-id">
                Meeting ID
              </label>
              <input
                id="meeting-id"
                className="input input--meeting"
                type="text"
                autoComplete="off"
                inputMode="text"
                placeholder="e.g. ABC12XY8"
                value={guestCode}
                onChange={(e) => setGuestCode(e.target.value)}
                disabled={busy || inCall}
              />
              <div className="lobby-card__actions lobby-card__actions--single">
                <button
                  type="button"
                  className="primary lobby-btn-main"
                  onClick={joinAsGuest}
                  disabled={busy || inCall || !guestCode.trim()}
                >
                  Join visit
                </button>
              </div>
            </section>
          </div>

          <footer className="lobby-status" role="status">
            <div className="lobby-status__pills">
              <span className="status-chip status-chip--muted">Standby</span>
              <span className="status-chip">Not in a call</span>
            </div>
            <p className="lobby-status__hint">
              Allow camera and microphone when your browser asks—needed for the
              video visit.
            </p>
          </footer>
        </div>
      )}

      {inCall && (
        <div className="meeting-workspace">
          <div className="meeting-main">
            <div className="video-gallery" role="list" aria-label="Video feeds">
              {participants.map((p) => {
                const tile = tileByAttendeeId.get(p.attendeeId);
                const live = showParticipantVideo(p);
                return (
                  <div
                    key={p.attendeeId}
                    className={`video-cell ${p.isSelf ? "video-cell--self" : ""}`}
                    role="listitem"
                  >
                    {live && tile ? (
                      <VideoTile
                        tileId={tile.tileId}
                        localTile={tile.localTile}
                        session={session}
                        label={videoLabelForParticipant(p)}
                        paused={tile.paused}
                      />
                    ) : (
                      <div className="video-placeholder">
                        <div className="video-placeholder__avatar">
                          {initialsFromDisplayName(p.displayName)}
                        </div>
                        <div className="video-placeholder__name">
                          {videoLabelForParticipant(p)}
                        </div>
                        <div className="video-placeholder__status">
                          {p.isSelf && localCamOn && !tile
                            ? "Starting camera…"
                            : p.isSelf && !localCamOn
                              ? "Your camera is off"
                              : tile?.paused
                                ? "Video paused"
                                : "Camera off"}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="meeting-toolbar" role="toolbar" aria-label="Call controls">
              <button
                type="button"
                className={`toolbar-btn ${micMuted ? "toolbar-btn--off" : ""}`}
                onClick={toggleMic}
                aria-pressed={micMuted}
              >
                {micMuted ? "Unmute mic" : "Mute mic"}
              </button>
              <button
                type="button"
                className={`toolbar-btn ${!localCamOn ? "toolbar-btn--off" : ""}`}
                onClick={toggleCamera}
                aria-pressed={!localCamOn}
              >
                {localCamOn ? "Stop camera" : "Start camera"}
              </button>
              <button
                type="button"
                className="toolbar-btn toolbar-btn--danger"
                onClick={leave}
              >
                Leave visit
              </button>
            </div>
          </div>

          <aside className="meeting-sidebar" aria-label="Documentation">
            <div className="transcript-speaker-panel transcript-speaker-panel--compact">
              <p className="transcript-speaker-panel__title">
                Transcript speaker (single device)
              </p>
              <p className="transcript-speaker-panel__hint">
                Who should your mic count as for this visit record?
              </p>
              <div
                className="segmented"
                role="group"
                aria-label="Attribute speech to role"
              >
                <button
                  type="button"
                  data-speaker="doctor"
                  aria-pressed={transcriptMicAs === "doctor"}
                  onClick={() => setTranscriptMicAs("doctor")}
                >
                  Clinician
                </button>
                <button
                  type="button"
                  data-speaker="patient"
                  aria-pressed={transcriptMicAs === "patient"}
                  onClick={() => setTranscriptMicAs("patient")}
                >
                  Patient
                </button>
              </div>
            </div>

            {transcriptRoomCode && (
              <section
                className="record-section record-section--sidebar"
                aria-labelledby="record-heading-title"
              >
                {visitRecordInner}
              </section>
            )}
          </aside>
        </div>
      )}

      {sttError && (
        <p className="stt-warning" role="alert">
          {sttError}
        </p>
      )}

      {!inCall && transcriptRoomCode && (
        <section
          className="record-section"
          aria-labelledby="record-heading-title"
        >
          {visitRecordInner}
        </section>
      )}
    </div>
  );
}
