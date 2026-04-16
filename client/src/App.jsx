import { useEffect, useMemo, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import {
  ConsoleLogger,
  DefaultDeviceController,
  DefaultMeetingSession,
  LogLevel,
  MeetingSessionConfiguration,
} from "amazon-chime-sdk-js";
import "./App.css";

const API_URL =
  import.meta.env.MODE === "development"
    ? import.meta.env.VITE_API_URL || "http://localhost:4000"
    : "";

/** CDN base for FFmpeg WASM — loaded lazily on first conversion request. */
const FFMPEG_CORE_BASE =
  "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";

function displayNameFromExternal(ext) {
  if (!ext) return "Participant";
  if (ext.startsWith("doctor-")) return "Clinician";
  if (ext.startsWith("patient-")) return "Patient";
  return "Participant";
}

function initialsFromDisplayName(name) {
  const parts = name.replace(/\s*\(you\)\s*/i, "").trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0]?.[0] ?? "?").toUpperCase();
}

function tileShowsCamera(tile) {
  if (!tile?.tileId) return false;
  if (tile.paused) return false;
  return true;
}

function formatDuration(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Mounts a <video> element and binds it to a Chime tile.
 * Each instance manages its own bind/unbind lifecycle.
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
  // ── Call state ──────────────────────────────────────────────────────────
  const [hostPayload, setHostPayload] = useState(null);
  const [guestCode, setGuestCode] = useState("");
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mediaConnected, setMediaConnected] = useState(false);
  const [participants, setParticipants] = useState([]);
  const [videoTiles, setVideoTiles] = useState({});
  const [visitContext, setVisitContext] = useState(null);
  const [micMuted, setMicMuted] = useState(false);
  const [localCamOn, setLocalCamOn] = useState(true);

  // ── Recording state ──────────────────────────────────────────────────────
  const [recording, setRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState(null);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [recordingUrl, setRecordingUrl] = useState(null);
  const [recordingError, setRecordingError] = useState(null);
  const [convertingFormat, setConvertingFormat] = useState(null);
  const [ffmpegLoading, setFfmpegLoading] = useState(false);

  // ── Refs ─────────────────────────────────────────────────────────────────
  const rosterRef = useRef(new Map());
  const audioElRef = useRef(null);
  const audioCtxRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const localMicStreamRef = useRef(null);
  const ffmpegRef = useRef(null);

  // ── Room code (for display only) ─────────────────────────────────────────
  const roomCode = visitContext?.roomCode ?? hostPayload?.roomCode ?? null;

  // ── Blob URL lifecycle ───────────────────────────────────────────────────
  useEffect(() => {
    if (!recordedBlob) {
      setRecordingUrl(null);
      return undefined;
    }
    const url = URL.createObjectURL(recordedBlob);
    setRecordingUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [recordedBlob]);

  // ── Recording duration timer ─────────────────────────────────────────────
  useEffect(() => {
    if (!recording) {
      setRecordingDuration(0);
      return undefined;
    }
    const t0 = Date.now();
    const id = setInterval(
      () => setRecordingDuration(Math.floor((Date.now() - t0) / 1000)),
      1000
    );
    return () => clearInterval(id);
  }, [recording]);

  // ── Recording ────────────────────────────────────────────────────────────

  const startRecording = async () => {
    try {
      // Capture remote audio directly from the Chime <audio> sink element.
      // captureStream() is supported in Chrome, Firefox, Edge (not Safari).
      const remoteStream = audioElRef.current?.captureStream?.();

      // Open a second mic stream for local audio. Chrome correctly routes
      // both calls to the same physical device without conflict.
      const localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      localMicStreamRef.current = localStream;

      // Mix both streams into a single AudioContext destination.
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const dest = audioCtx.createMediaStreamDestination();

      if (remoteStream) {
        audioCtx.createMediaStreamSource(remoteStream).connect(dest);
      }
      audioCtx.createMediaStreamSource(localStream).connect(dest);

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : null;

      if (!mimeType) {
        setRecordingError(
          "Recording is not supported in this browser. Use Chrome or Edge."
        );
        return;
      }

      const recorder = new MediaRecorder(dest.stream, { mimeType });
      recordedChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, {
          type: "audio/webm",
        });
        setRecordedBlob(blob);
      };

      // Collect a chunk every second so we get data even on short calls.
      recorder.start(1000);
      mediaRecorderRef.current = recorder;
      setRecording(true);
      setRecordingError(null);
    } catch (err) {
      console.error("startRecording:", err);
      setRecordingError(`Could not start recording: ${err.message}`);
    }
  };

  const stopRecording = () => {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    audioCtxRef.current?.close();
    localMicStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaRecorderRef.current = null;
    audioCtxRef.current = null;
    localMicStreamRef.current = null;
    setRecording(false);
  };

  // ── FFmpeg / Download ─────────────────────────────────────────────────────

  const loadFFmpeg = async () => {
    if (ffmpegRef.current?.loaded) return ffmpegRef.current;
    setFfmpegLoading(true);
    try {
      const ff = new FFmpeg();
      await ff.load({
        coreURL: await toBlobURL(
          `${FFMPEG_CORE_BASE}/ffmpeg-core.js`,
          "text/javascript"
        ),
        wasmURL: await toBlobURL(
          `${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`,
          "application/wasm"
        ),
      });
      ffmpegRef.current = ff;
      return ff;
    } finally {
      setFfmpegLoading(false);
    }
  };

  const triggerDownload = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const downloadAs = async (format) => {
    if (!recordedBlob) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");

    if (format === "webm") {
      triggerDownload(recordedBlob, `call-${stamp}.webm`);
      return;
    }

    setConvertingFormat(format);
    try {
      const ff = await loadFFmpeg();

      await ff.writeFile("input.webm", await fetchFile(recordedBlob));

      if (format === "mp3") {
        await ff.exec(["-i", "input.webm", "-vn", "-b:a", "128k", "output.mp3"]);
        const data = await ff.readFile("output.mp3");
        triggerDownload(
          new Blob([data.buffer], { type: "audio/mpeg" }),
          `call-${stamp}.mp3`
        );
        await ff.deleteFile("output.mp3");
      } else if (format === "mp4") {
        await ff.exec([
          "-i", "input.webm",
          "-vn", "-c:a", "aac", "-b:a", "128k",
          "output.mp4",
        ]);
        const data = await ff.readFile("output.mp4");
        triggerDownload(
          new Blob([data.buffer], { type: "audio/mp4" }),
          `call-${stamp}.mp4`
        );
        await ff.deleteFile("output.mp4");
      }

      await ff.deleteFile("input.webm");
    } catch (err) {
      console.error("Conversion failed:", err);
      alert(
        `Could not convert to ${format.toUpperCase()}. Download the WebM file and convert locally if needed.`
      );
    } finally {
      setConvertingFormat(null);
    }
  };

  // ── Chime session ────────────────────────────────────────────────────────

  const connectChime = async (meeting, attendee, meta) => {
    // Clear any previous recording before a new call.
    setRecordedBlob(null);
    setRecordingError(null);
    rosterRef.current = new Map();
    setParticipants([]);
    setVideoTiles({});
    setMediaConnected(false);
    setLocalCamOn(true);

    const logger = new ConsoleLogger("ChimeLogs", LogLevel.INFO);
    const deviceController = new DefaultDeviceController(logger);
    const config = new MeetingSessionConfiguration(meeting, attendee);
    const meetingSession = new DefaultMeetingSession(config, logger, deviceController);

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
        { attendeeId: myId, displayName: `${localLabel} (you)`, isSelf: true },
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
          rosterRef.current.set(attendeeId, { externalUserId: externalUserId || "" });
        } else {
          rosterRef.current.delete(attendeeId);
        }
        syncRosterToState();
      }
    );

    const audioInputs = await meetingSession.audioVideo.listAudioInputDevices();
    const audioDeviceId = audioInputs[0]?.deviceId ?? "default";
    await meetingSession.audioVideo.startAudioInput(audioDeviceId);

    const videoInputs = await meetingSession.audioVideo.listVideoInputDevices();
    if (videoInputs.length > 0) {
      await meetingSession.audioVideo.startVideoInput(videoInputs[0].deviceId);
    }

    if (audioElRef.current) {
      await meetingSession.audioVideo.bindAudioElement(audioElRef.current);
    }

    meetingSession.audioVideo.start();
    meetingSession.audioVideo.startLocalVideoTile();

    meetingSession.audioVideo.realtimeSubscribeToMuteAndUnmuteLocalAudio(
      (muted) => setMicMuted(muted)
    );
    setMicMuted(meetingSession.audioVideo.realtimeIsLocalAudioMuted());

    syncRosterToState();
    setVisitContext({ roomCode: meta.roomCode, role: meta.role });
    setSession(meetingSession);

    // Start recording after the session is fully wired up.
    await startRecording();
  };

  const startVisitAsDoctor = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/meeting`, { method: "POST" });
      const raw = await res.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`Non-JSON from /api/meeting: ${raw.slice(0, 300)}`);
      }
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
    stopRecording();
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

  // ── Derived ──────────────────────────────────────────────────────────────

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
    if (!roomCode) return;
    try {
      await navigator.clipboard.writeText(roomCode);
    } catch {
      prompt("Meeting ID:", roomCode);
    }
  };

  const videoLabelForParticipant = (p) => {
    if (p.isSelf) {
      return visitContext?.role === "doctor" ? "Clinician (you)" : "Patient (you)";
    }
    return p.displayName;
  };

  const showParticipantVideo = (p) => {
    if (p.isSelf && !localCamOn) return false;
    const tile = tileByAttendeeId.get(p.attendeeId);
    if (!tile) return false;
    return tileShowsCamera(tile);
  };

  const inCall = Boolean(session);
  const isConverting = Boolean(convertingFormat);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className={`app-shell ${inCall ? "app-shell--meeting" : ""}`}>
      {/* Hidden audio sink — Chime routes all remote audio through this element */}
      <audio ref={audioElRef} autoPlay style={{ display: "none" }} />

      {/* ── Top bar / Lobby ── */}
      {inCall ? (
        <header className="meeting-topbar">
          <div className="meeting-topbar__left">
            <div className="app-logo app-logo--sm" aria-hidden />
            <div>
              <div className="meeting-topbar__title">Telehealth appointment</div>
              <div className="meeting-topbar__meta">
                <span className="mono-id">{roomCode}</span>
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

      {/* ── In-call workspace ── */}
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

          {/* ── Recording sidebar ── */}
          <aside className="meeting-sidebar" aria-label="Recording status">
            <div className="rec-status-panel">
              <div className="rec-status-panel__header">
                <span className="rec-badge">
                  <span className={`rec-dot ${recording ? "rec-dot--live" : ""}`} />
                  {recording ? "Recording" : "Initialising…"}
                </span>
                {recording && (
                  <span className="rec-timer">{formatDuration(recordingDuration)}</span>
                )}
              </div>
              <p className="rec-status-panel__hint">
                Both voices are captured automatically. The recording will be
                available for playback and download after you leave.
              </p>
              {recordingError && (
                <p className="rec-error" role="alert">{recordingError}</p>
              )}
            </div>
          </aside>
        </div>
      )}

      {/* ── Post-call recording playback ── */}
      {!inCall && recordedBlob && (
        <section className="recording-panel" aria-label="Call recording">
          <div className="recording-panel__inner">
            <div className="recording-panel__head">
              <h2 className="recording-panel__title">Call recording</h2>
              {roomCode && (
                <span className="recording-panel__meta">Meeting {roomCode}</span>
              )}
            </div>

            <audio
              controls
              src={recordingUrl}
              className="recording-player"
              aria-label="Recorded call audio"
            />

            <div className="recording-downloads">
              <p className="recording-downloads__label">Download as:</p>
              <div className="recording-downloads__btns">
                <button
                  type="button"
                  className="dl-btn"
                  onClick={() => downloadAs("webm")}
                  disabled={isConverting}
                >
                  WebM
                </button>
                <button
                  type="button"
                  className="dl-btn"
                  onClick={() => downloadAs("mp3")}
                  disabled={isConverting}
                >
                  {convertingFormat === "mp3"
                    ? "Converting…"
                    : "MP3"}
                </button>
                <button
                  type="button"
                  className="dl-btn"
                  onClick={() => downloadAs("mp4")}
                  disabled={isConverting}
                >
                  {convertingFormat === "mp4"
                    ? "Converting…"
                    : "MP4"}
                </button>
              </div>
            </div>

            {(isConverting || ffmpegLoading) && (
              <p className="recording-converting-hint">
                {ffmpegLoading
                  ? "Loading audio converter (~30 MB, one-time download)…"
                  : `Converting to ${convertingFormat?.toUpperCase()}…`}
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
