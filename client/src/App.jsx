import { useEffect, useMemo, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import "./App.css";

// REST + WebSocket signaling share this base. In production, set VITE_API_URL at
// build time if the API runs on a different host/port than the static site
// (e.g. http://54.221.8.195:4000); otherwise same-origin "" is used.
const API_URL =
  (typeof import.meta.env.VITE_API_URL === "string" && import.meta.env.VITE_API_URL.trim()) ||
  (import.meta.env.MODE === "development" ? "http://localhost:4000" : "");

const FFMPEG_CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function hasUsableVideo(stream) {
  if (!stream) return false;
  return stream.getVideoTracks().some((t) => t.readyState === "live");
}

function formatDuration(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ─── SVG Icons ───────────────────────────────────────────────────────────────

const MicOnIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
);

const MicOffIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
    <line x1="1" y1="1" x2="23" y2="23" />
    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6" />
    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14-2v2" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
);

const CamOnIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
    <path d="M23 7l-7 5 7 5V7z" />
    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
  </svg>
);

const CamOffIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
    <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" />
    <path d="M23 7l-7 5 7 5V7z" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

// ─── PreJoinScreen ────────────────────────────────────────────────────────────

function PreJoinScreen({ role, roomCode, stream, camOn, micOn, onToggleCam, onToggleMic, onJoin, onCancel, busy }) {
  const videoRef = useRef(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = camOn && stream ? stream : null;
  }, [stream, camOn]);

  return (
    <div className="prejoin">
      <div className="prejoin__card">

        {/* Left — camera preview */}
        <div className="prejoin__preview">
          {camOn && stream ? (
            <video ref={videoRef} autoPlay playsInline muted className="prejoin__video" />
          ) : (
            <div className="prejoin__no-cam">
              <CamOffIcon />
              <span>Your camera is off</span>
            </div>
          )}
        </div>

        {/* Right — settings */}
        <div className="prejoin__settings">
          <div className="prejoin__settings-top">
            <div className="app-logo app-logo--sm" aria-hidden />
            <h1 className="prejoin__title">Telehealth Visit</h1>
          </div>

          <p className="prejoin__subtitle">
            {role === "doctor" ? "Clinician" : "Patient"}
            {roomCode && <span className="prejoin__room-code"> · {roomCode}</span>}
          </p>

          <h2 className="prejoin__ready">Ready to join?</h2>

          <div className="prejoin__devices">
            {/* Mic row */}
            <button
              type="button"
              className={`prejoin__device-row ${!micOn ? "prejoin__device-row--off" : ""}`}
              onClick={onToggleMic}
              aria-pressed={micOn}
            >
              <span className="prejoin__device-icon">
                {micOn ? <MicOnIcon /> : <MicOffIcon />}
              </span>
              <span className="prejoin__device-label">
                {micOn ? "Microphone on" : "Microphone muted"}
              </span>
              <span className={`prejoin__toggle ${micOn ? "prejoin__toggle--on" : ""}`}>
                <span className="prejoin__toggle-knob" />
              </span>
            </button>

            {/* Camera row */}
            <button
              type="button"
              className={`prejoin__device-row ${!camOn ? "prejoin__device-row--off" : ""}`}
              onClick={onToggleCam}
              aria-pressed={camOn}
            >
              <span className="prejoin__device-icon">
                {camOn ? <CamOnIcon /> : <CamOffIcon />}
              </span>
              <span className="prejoin__device-label">
                {camOn ? "Camera on" : "Camera off"}
              </span>
              <span className={`prejoin__toggle ${camOn ? "prejoin__toggle--on" : ""}`}>
                <span className="prejoin__toggle-knob" />
              </span>
            </button>
          </div>

          <div className="prejoin__actions">
            <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="primary prejoin__join-btn" onClick={onJoin} disabled={busy}>
              {busy ? "Please wait…" : role === "doctor" ? "Join now" : "Ask to join"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── WaitingRoom ──────────────────────────────────────────────────────────────

function WaitingRoom({ roomCode, stream, camOn, micOn, onToggleCam, onToggleMic, onCancel }) {
  const videoRef = useRef(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = camOn && stream ? stream : null;
  }, [stream, camOn]);

  return (
    <div className="prejoin">
      <div className="prejoin__card">

        {/* Left — self preview */}
        <div className="prejoin__preview">
          {camOn && stream ? (
            <video ref={videoRef} autoPlay playsInline muted className="prejoin__video" />
          ) : (
            <div className="prejoin__no-cam">
              <CamOffIcon />
              <span>Your camera is off</span>
            </div>
          )}
        </div>

        {/* Right — waiting status */}
        <div className="prejoin__settings">
          <div className="prejoin__settings-top">
            <div className="app-logo app-logo--sm" aria-hidden />
            <h1 className="prejoin__title">Telehealth Visit</h1>
          </div>

          {roomCode && (
            <p className="prejoin__subtitle">
              <span className="prejoin__room-code">{roomCode}</span>
            </p>
          )}

          <div className="waiting__status">
            <div className="waiting__spinner" aria-hidden />
            <h2 className="waiting__heading">Waiting to be admitted…</h2>
            <p className="waiting__hint">
              The clinician will let you in shortly.
            </p>
          </div>

          <div className="prejoin__devices">
            <button
              type="button"
              className={`prejoin__device-row ${!micOn ? "prejoin__device-row--off" : ""}`}
              onClick={onToggleMic}
              aria-pressed={micOn}
            >
              <span className="prejoin__device-icon">
                {micOn ? <MicOnIcon /> : <MicOffIcon />}
              </span>
              <span className="prejoin__device-label">
                {micOn ? "Microphone on" : "Microphone muted"}
              </span>
              <span className={`prejoin__toggle ${micOn ? "prejoin__toggle--on" : ""}`}>
                <span className="prejoin__toggle-knob" />
              </span>
            </button>

            <button
              type="button"
              className={`prejoin__device-row ${!camOn ? "prejoin__device-row--off" : ""}`}
              onClick={onToggleCam}
              aria-pressed={camOn}
            >
              <span className="prejoin__device-icon">
                {camOn ? <CamOnIcon /> : <CamOffIcon />}
              </span>
              <span className="prejoin__device-label">
                {camOn ? "Camera on" : "Camera off"}
              </span>
              <span className={`prejoin__toggle ${camOn ? "prejoin__toggle--on" : ""}`}>
                <span className="prejoin__toggle-knob" />
              </span>
            </button>
          </div>

          <div className="prejoin__actions">
            <button type="button" className="secondary" onClick={onCancel}>
              Leave waiting room
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── VideoTile ────────────────────────────────────────────────────────────────

function VideoTile({ stream, localTile, label, visible = true }) {
  const videoRef = useRef(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream ?? null;
  }, [stream]);

  return (
    <div className={`video-tile-wrap video-tile-wrap--live ${visible ? "" : "video-tile-wrap--hidden"}`}>
      <video ref={videoRef} autoPlay playsInline muted={Boolean(localTile)} />
      {visible && <div className="video-tile-label">{label}</div>}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {

  // ── Call state ─────────────────────────────────────────────────────────
  const [hostPayload, setHostPayload] = useState(null);
  const [guestCode, setGuestCode] = useState("");
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mediaConnected, setMediaConnected] = useState(false);
  const [participants, setParticipants] = useState([]);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [, setPeerIds] = useState([]);
  const [visitContext, setVisitContext] = useState(null);
  const [micMuted, setMicMuted] = useState(false);
  const [localCamOn, setLocalCamOn] = useState(true);

  // ── Screen state ────────────────────────────────────────────────────────
  // "lobby" | "prejoin" | "waiting"
  // When session !== null the meeting UI is shown regardless of screen.
  const [screen, setScreen] = useState("lobby");
  const [prejoinRole, setPrejoinRole] = useState(null); // "doctor" | "patient"
  const [prejoinStream, setPrejoinStream] = useState(null);
  const [prejoinCamOn, setPrejoinCamOn] = useState(true);
  const [prejoinMicOn, setPrejoinMicOn] = useState(true);

  // ── Waiting room ────────────────────────────────────────────────────────
  const [knockId, setKnockId] = useState(null);
  const [admittedData, setAdmittedData] = useState(null);

  // ── Doctor admit queue ──────────────────────────────────────────────────
  const [pendingKnocks, setPendingKnocks] = useState([]);

  // ── Recording state ─────────────────────────────────────────────────────
  const [recording, setRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState(null);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [recordingUrl, setRecordingUrl] = useState(null);
  const [recordingError, setRecordingError] = useState(null);
  const [convertingFormat, setConvertingFormat] = useState(null);
  const [ffmpegLoading, setFfmpegLoading] = useState(false);

  // ── Refs ────────────────────────────────────────────────────────────────
  const wsRef = useRef(null);
  const peerConnectionsRef = useRef(new Map());
  const remoteStreamsRef = useRef(new Map());
  const localCallStreamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const localMicStreamRef = useRef(null);
  const ffmpegRef = useRef(null);
  const recordingDestRef = useRef(null);       // AudioContext destination node
  const connectedRemoteRecordingTrackIdsRef = useRef(new Set());
  const streamAddTrackListenersRef = useRef(new WeakSet());
  const prejoinStreamRef = useRef(null);

  const roomCode = visitContext?.roomCode ?? hostPayload?.roomCode ?? null;
  const inCall = Boolean(session);
  const rtcConfig = useMemo(() => ({ iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] }), []);

  // ── Blob URL lifecycle ──────────────────────────────────────────────────
  useEffect(() => {
    if (!recordedBlob) { setRecordingUrl(null); return undefined; }
    const url = URL.createObjectURL(recordedBlob);
    setRecordingUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [recordedBlob]);

  // ── Recording duration timer ────────────────────────────────────────────
  useEffect(() => {
    if (!recording) { setRecordingDuration(0); return undefined; }
    const t0 = Date.now();
    const id = setInterval(() => setRecordingDuration(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [recording]);

  // ── Patient: poll knock status while waiting ────────────────────────────
  useEffect(() => {
    if (screen !== "waiting" || !knockId) return undefined;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`${API_URL}/api/meeting/knock/${knockId}`);
        if (cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.status === "admitted") {
          cancelled = true;
          clearInterval(id);
          setAdmittedData(data);
        } else if (data.status === "denied") {
          cancelled = true;
          clearInterval(id);
          stopPrejoinStream();
          setKnockId(null);
          setScreen("lobby");
          alert("Your request to join was declined by the clinician.");
        }
      } catch (err) {
        console.error("knock poll:", err);
      }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [screen, knockId]);

  // ── Patient: join when admitted ─────────────────────────────────────────
  useEffect(() => {
    if (!admittedData) return;
    const { participantId, roomCode: admittedRoom } = admittedData;
    const muted = !prejoinMicOn;
    const camOff = !prejoinCamOn;
    setAdmittedData(null);
    stopPrejoinStream();
    connectWebRTC({
      roomCode: admittedRoom,
      role: "patient",
      participantId,
      initialMuted: muted,
      initialCamOff: camOff,
    }).catch((err) => {
      console.error(err);
      alert(err.message || "Could not join call");
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admittedData]);

  // ── Doctor: poll waiting room while in call ─────────────────────────────
  useEffect(() => {
    if (!inCall || visitContext?.role !== "doctor" || !visitContext?.roomCode) return undefined;
    const poll = async () => {
      try {
        const res = await fetch(`${API_URL}/api/meeting/${visitContext.roomCode}/knocks`);
        const data = await res.json();
        if (Array.isArray(data.knocks)) setPendingKnocks(data.knocks);
      } catch (err) {
        console.error("knocks poll:", err);
      }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [inCall, visitContext]);

  // ── Pre-join helpers ────────────────────────────────────────────────────

  const stopPrejoinStream = () => {
    prejoinStreamRef.current?.getTracks().forEach((t) => t.stop());
    prejoinStreamRef.current = null;
    setPrejoinStream(null);
  };

  const enterPrejoin = async (role) => {
    let stream = null;
    let camOn = true;
    let micOn = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        camOn = false;
      } catch {
        camOn = false;
        micOn = false;
      }
    }
    prejoinStreamRef.current = stream;
    setPrejoinStream(stream);
    setPrejoinCamOn(camOn);
    setPrejoinMicOn(micOn);
    setPrejoinRole(role);
    setScreen("prejoin");
  };

  const togglePrejoinCam = () => {
    const s = prejoinStreamRef.current;
    if (s) s.getVideoTracks().forEach((t) => { t.enabled = !t.enabled; });
    setPrejoinCamOn((v) => !v);
  };

  const togglePrejoinMic = () => {
    const s = prejoinStreamRef.current;
    if (s) s.getAudioTracks().forEach((t) => { t.enabled = !t.enabled; });
    setPrejoinMicOn((v) => !v);
  };

  const cancelPrejoin = () => {
    stopPrejoinStream();
    setScreen("lobby");
  };

  const cancelWaiting = () => {
    stopPrejoinStream();
    setKnockId(null);
    setScreen("lobby");
  };

  /** Called when the user clicks "Join now" (doctor) or "Ask to join" (patient). */
  const confirmJoin = async () => {
    if (prejoinRole === "doctor") {
      stopPrejoinStream();
      setBusy(true);
      try {
        await connectWebRTC({
          roomCode: hostPayload.roomCode,
          role: "doctor",
          participantId: hostPayload.participantId,
          initialMuted: !prejoinMicOn,
          initialCamOff: !prejoinCamOn,
        });
        setScreen("lobby");
      } catch (e) {
        console.error(e);
        alert(e.message || "Could not join call");
      } finally {
        setBusy(false);
      }
    } else {
      // Patient knocks and moves to the waiting room (stream stays alive)
      const code = guestCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      setBusy(true);
      try {
        const res = await fetch(`${API_URL}/api/meeting/knock`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomCode: code }),
        });
        // Parse JSON safely — if the server returned HTML (e.g. old server build
        // without the knock endpoint) `res.json()` would throw a cryptic parse
        // error. Catching here gives a clear message instead.
        let data;
        try {
          data = await res.json();
        } catch {
          throw new Error(
            res.status === 404
              ? "Meeting not found — check the ID and try again."
              : `Server error (${res.status}). Make sure the server has been restarted.`
          );
        }
        if (!res.ok) throw new Error(data.error || "Could not request to join");
        setKnockId(data.knockId);
        setScreen("waiting");
      } catch (e) {
        console.error(e);
        alert(e.message || "Could not request to join");
      } finally {
        setBusy(false);
      }
    }
  };

  // ── Doctor admit/deny ───────────────────────────────────────────────────

  const admitKnock = async (id) => {
    try {
      await fetch(`${API_URL}/api/meeting/${visitContext.roomCode}/admit/${id}`, { method: "POST" });
      setPendingKnocks((prev) => prev.filter((k) => k.knockId !== id));
    } catch (err) {
      console.error("admit:", err);
    }
  };

  const denyKnock = async (id) => {
    try {
      await fetch(`${API_URL}/api/meeting/${visitContext.roomCode}/deny/${id}`, { method: "POST" });
      setPendingKnocks((prev) => prev.filter((k) => k.knockId !== id));
    } catch (err) {
      console.error("deny:", err);
    }
  };

  // ── Recording ───────────────────────────────────────────────────────────
  // Recording starts when the signaling socket opens — often *before* WebRTC
  // has remote media. We must add remote audio to the mix when `ontrack` fires.
  const connectRemoteAudioToRecording = (stream) => {
    const dest = recordingDestRef.current;
    const ctx = audioCtxRef.current;
    if (!dest || !ctx || !stream) return;
    for (const track of stream.getAudioTracks()) {
      if (track.readyState === "ended") continue;
      if (connectedRemoteRecordingTrackIdsRef.current.has(track.id)) continue;
      connectedRemoteRecordingTrackIdsRef.current.add(track.id);
      try {
        ctx.createMediaStreamSource(new MediaStream([track])).connect(dest);
      } catch (e) {
        console.warn("connectRemoteAudioToRecording:", e);
      }
    }
  };

  const startRecording = async (initialMuted = false) => {
    try {
      const localBase = localCallStreamRef.current;
      let localStream;
      const localAudioTracks = localBase?.getAudioTracks() ?? [];
      if (localAudioTracks.length > 0) {
        localStream = new MediaStream(localAudioTracks.map((t) => t.clone()));
      } else {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false,
        });
      }
      // Apply the join-time mute state immediately so there's no window where
      // a muted-on-join user's voice leaks into the recording.
      if (initialMuted) {
        localStream.getAudioTracks().forEach((t) => { t.enabled = false; });
      }
      localMicStreamRef.current = localStream;

      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const dest = audioCtx.createMediaStreamDestination();
      recordingDestRef.current = dest;
      connectedRemoteRecordingTrackIdsRef.current = new Set();

      for (const stream of remoteStreamsRef.current.values()) {
        connectRemoteAudioToRecording(stream);
      }
      audioCtx.createMediaStreamSource(localStream).connect(dest);

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : null;

      if (!mimeType) {
        setRecordingError("Recording is not supported in this browser. Use Chrome or Edge.");
        return;
      }

      const recorder = new MediaRecorder(dest.stream, { mimeType });
      recordedChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunksRef.current.push(e.data); };
      recorder.onstop = () => {
        setRecordedBlob(new Blob(recordedChunksRef.current, { type: "audio/webm" }));
      };
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
    recordingDestRef.current = null;
    connectedRemoteRecordingTrackIdsRef.current = new Set();
    setRecording(false);
  };

  // ── FFmpeg / download ───────────────────────────────────────────────────

  const loadFFmpeg = async () => {
    if (ffmpegRef.current?.loaded) return ffmpegRef.current;
    setFfmpegLoading(true);
    try {
      const ff = new FFmpeg();
      await ff.load({
        coreURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
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
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const downloadAs = async (format) => {
    if (!recordedBlob) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    if (format === "webm") { triggerDownload(recordedBlob, `call-${stamp}.webm`); return; }
    setConvertingFormat(format);
    try {
      const ff = await loadFFmpeg();
      await ff.writeFile("input.webm", await fetchFile(recordedBlob));
      if (format === "mp3") {
        await ff.exec(["-i", "input.webm", "-vn", "-b:a", "128k", "output.mp3"]);
        const data = await ff.readFile("output.mp3");
        triggerDownload(new Blob([data.buffer], { type: "audio/mpeg" }), `call-${stamp}.mp3`);
        await ff.deleteFile("output.mp3");
      } else if (format === "mp4") {
        await ff.exec(["-i", "input.webm", "-vn", "-c:a", "aac", "-b:a", "128k", "output.mp4"]);
        const data = await ff.readFile("output.mp4");
        triggerDownload(new Blob([data.buffer], { type: "audio/mp4" }), `call-${stamp}.mp4`);
        await ff.deleteFile("output.mp4");
      }
      await ff.deleteFile("input.webm");
    } catch (err) {
      console.error("Conversion failed:", err);
      alert(`Could not convert to ${format.toUpperCase()}. Try downloading as WebM.`);
    } finally {
      setConvertingFormat(null);
    }
  };

  // ── WebRTC session ──────────────────────────────────────────────────────

  const syncParticipants = (meta, selfId, ids) => {
    const localLabel = meta.role === "doctor" ? "Clinician" : "Patient";
    const remotes = ids.map((id) => ({
      attendeeId: id,
      displayName: displayNameFromExternal(id),
      isSelf: false,
    }));
    remotes.sort((a, b) => a.displayName.localeCompare(b.displayName));
    setParticipants([{ attendeeId: selfId, displayName: `${localLabel} (you)`, isSelf: true }, ...remotes]);
  };

  const closePeer = (peerId) => {
    const pc = peerConnectionsRef.current.get(peerId);
    if (pc) {
      try { pc.close(); } catch { /* noop */ }
      peerConnectionsRef.current.delete(peerId);
    }
    remoteStreamsRef.current.delete(peerId);
    setRemoteStreams((prev) => {
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  };

  const createPeerConnection = (peerId, ws) => {
    if (peerConnectionsRef.current.has(peerId)) return peerConnectionsRef.current.get(peerId);
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnectionsRef.current.set(peerId, pc);
    const local = localCallStreamRef.current;
    if (local) {
      for (const track of local.getTracks()) pc.addTrack(track, local);
    }
    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      remoteStreamsRef.current.set(peerId, stream);
      setRemoteStreams((prev) => ({ ...prev, [peerId]: stream }));
      connectRemoteAudioToRecording(stream);
      if (!streamAddTrackListenersRef.current.has(stream)) {
        streamAddTrackListenersRef.current.add(stream);
        stream.addEventListener("addtrack", () => connectRemoteAudioToRecording(stream));
      }
    };
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      ws.send(JSON.stringify({ type: "signal", to: peerId, data: { candidate: event.candidate } }));
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        closePeer(peerId);
      }
    };
    return pc;
  };

  const connectWebRTC = async (meta) => {
    setRecordedBlob(null);
    setRecordingError(null);
    setParticipants([]);
    setRemoteStreams({});
    remoteStreamsRef.current = new Map();
    setPeerIds([]);
    setMediaConnected(false);
    setLocalCamOn(!meta.initialCamOff);
    setPendingKnocks([]);

    let local = prejoinStreamRef.current;
    if (!local) {
      local = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    }
    local.getAudioTracks().forEach((t) => { t.enabled = !meta.initialMuted; });
    local.getVideoTracks().forEach((t) => { t.enabled = !meta.initialCamOff; });
    localCallStreamRef.current = local;
    setMicMuted(meta.initialMuted);

    const base = API_URL || window.location.origin;
    const wsUrl = new URL(base);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.searchParams.set("roomCode", meta.roomCode);
    wsUrl.searchParams.set("participantId", meta.participantId);
    wsUrl.searchParams.set("role", meta.role);

    const ws = new WebSocket(wsUrl.toString());
    wsRef.current = ws;
    ws.onopen = async () => {
      setMediaConnected(true);
      await startRecording(meta.initialMuted ?? false);
    };
    ws.onclose = () => setMediaConnected(false);

    ws.onmessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === "peers" && Array.isArray(msg.peers)) {
        setPeerIds(msg.peers);
        syncParticipants(meta, meta.participantId, msg.peers);
        return;
      }

      if (msg.type === "peer-joined" && typeof msg.peerId === "string") {
        setPeerIds((prev) => {
          const next = prev.includes(msg.peerId) ? prev : [...prev, msg.peerId];
          syncParticipants(meta, meta.participantId, next);
          return next;
        });
        const pc = createPeerConnection(msg.peerId, ws);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: "signal", to: msg.peerId, data: { sdp: pc.localDescription } }));
        return;
      }

      if (msg.type === "peer-left" && typeof msg.peerId === "string") {
        closePeer(msg.peerId);
        setPeerIds((prev) => {
          const next = prev.filter((id) => id !== msg.peerId);
          syncParticipants(meta, meta.participantId, next);
          return next;
        });
        return;
      }

      if (msg.type === "signal" && typeof msg.from === "string" && msg.data) {
        const pc = createPeerConnection(msg.from, ws);
        if (msg.data.sdp) {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.data.sdp));
          if (msg.data.sdp.type === "offer") {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ws.send(JSON.stringify({ type: "signal", to: msg.from, data: { sdp: pc.localDescription } }));
          }
        } else if (msg.data.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(msg.data.candidate));
        }
      }
    };

    syncParticipants(meta, meta.participantId, []);
    setVisitContext({ roomCode: meta.roomCode, role: meta.role });
    setSession({ roomCode: meta.roomCode, role: meta.role, participantId: meta.participantId });
  };

  // ── Lobby actions ───────────────────────────────────────────────────────

  const startVisitAsDoctor = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/meeting`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start visit");
      setHostPayload({ roomCode: data.roomCode, participantId: data.participantId });
    } catch (e) {
      console.error(e); alert(e.message || "Failed to start visit");
    } finally {
      setBusy(false);
    }
  };

  const handleDoctorJoinRequest = () => {
    if (!hostPayload) return;
    enterPrejoin("doctor");
  };

  const handlePatientJoinRequest = () => {
    const code = guestCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length < 4) { alert("Enter the meeting ID from the host."); return; }
    enterPrejoin("patient");
  };

  const leave = () => {
    stopRecording();
    wsRef.current?.close();
    wsRef.current = null;
    for (const pc of peerConnectionsRef.current.values()) {
      try { pc.close(); } catch { /* noop */ }
    }
    peerConnectionsRef.current.clear();
    if (localCallStreamRef.current) {
      localCallStreamRef.current.getTracks().forEach((t) => t.stop());
      localCallStreamRef.current = null;
    }
    remoteStreamsRef.current = new Map();
    setRemoteStreams({});
    setPeerIds([]);
    setSession(null);
    setVisitContext(null);
    setMediaConnected(false);
    setParticipants([]);
    setMicMuted(false);
    setLocalCamOn(true);
    setPendingKnocks([]);
    setScreen("lobby");
  };

  const toggleMic = () => {
    if (!localCallStreamRef.current) return;
    const nextMuted = !micMuted;
    localCallStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = !nextMuted; });
    localMicStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = !nextMuted; });
    setMicMuted(nextMuted);
  };

  const toggleCamera = () => {
    if (!localCallStreamRef.current) return;
    const nextCamOn = !localCamOn;
    localCallStreamRef.current.getVideoTracks().forEach((t) => { t.enabled = nextCamOn; });
    setLocalCamOn(nextCamOn);
  };

  // ── Derived ─────────────────────────────────────────────────────────────

  const remoteOthersCount = Math.max(0, participants.length - 1);

  const streamByAttendeeId = useMemo(() => {
    const m = new Map();
    if (session?.participantId) m.set(session.participantId, localCallStreamRef.current);
    for (const [id, stream] of Object.entries(remoteStreams)) m.set(id, stream);
    return m;
  }, [remoteStreams, session]);

  const copyRoomCode = async () => {
    if (!hostPayload?.roomCode) return;
    try { await navigator.clipboard.writeText(hostPayload.roomCode); }
    catch { prompt("Copy this meeting ID:", hostPayload.roomCode); }
  };

  const copyMeetingId = async () => {
    if (!roomCode) return;
    try { await navigator.clipboard.writeText(roomCode); }
    catch { prompt("Meeting ID:", roomCode); }
  };

  const videoLabelForParticipant = (p) => {
    if (p.isSelf) return visitContext?.role === "doctor" ? "Clinician (you)" : "Patient (you)";
    return p.displayName;
  };

  const showParticipantVideo = (p) => {
    if (p.isSelf && !localCamOn) return false;
    return hasUsableVideo(streamByAttendeeId.get(p.attendeeId));
  };

  const isConverting = Boolean(convertingFormat);

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className={`app-shell ${inCall ? "app-shell--meeting" : ""}`}>
      {/* ── Pre-join screen ── */}
      {!inCall && screen === "prejoin" && (
        <PreJoinScreen
          role={prejoinRole}
          roomCode={prejoinRole === "doctor" ? hostPayload?.roomCode : guestCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")}
          stream={prejoinStream}
          camOn={prejoinCamOn}
          micOn={prejoinMicOn}
          onToggleCam={togglePrejoinCam}
          onToggleMic={togglePrejoinMic}
          onJoin={confirmJoin}
          onCancel={cancelPrejoin}
          busy={busy}
        />
      )}

      {/* ── Waiting room ── */}
      {!inCall && screen === "waiting" && (
        <WaitingRoom
          roomCode={guestCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")}
          stream={prejoinStream}
          camOn={prejoinCamOn}
          micOn={prejoinMicOn}
          onToggleCam={togglePrejoinCam}
          onToggleMic={togglePrejoinMic}
          onCancel={cancelWaiting}
        />
      )}

      {/* ── Lobby ── */}
      {!inCall && screen === "lobby" && (
        <>
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
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                      <path d="M4.5 9.5V5.5C4.5 4.39543 5.39543 3.5 6.5 3.5H17.5C18.6046 3.5 19.5 4.39543 19.5 5.5V9.5" />
                      <path d="M8 21.5V17.5C8 16.3954 8.89543 15.5 10 15.5H14C15.1046 15.5 16 16.3954 16 17.5V21.5" />
                      <path d="M12 12.5C13.3807 12.5 14.5 11.3807 14.5 10C14.5 8.61929 13.3807 7.5 12 7.5C10.6193 7.5 9.5 8.61929 9.5 10C9.5 11.3807 10.6193 12.5 12 12.5Z" />
                    </svg>
                  </div>
                  <div>
                    <h2 id="host-heading">Clinician</h2>
                    <p className="lobby-card__text">
                      Open a new visit room, then share the meeting ID with your patient.
                    </p>
                  </div>
                </div>
                <div className="lobby-card__actions">
                  <button type="button" className="primary lobby-btn-main" onClick={startVisitAsDoctor} disabled={busy}>
                    Start new visit
                  </button>
                  <button type="button" className="secondary" onClick={handleDoctorJoinRequest} disabled={busy || !hostPayload}>
                    Join as host
                  </button>
                </div>
                {hostPayload && (
                  <div className="room-banner">
                    <p className="room-label">Active meeting ID</p>
                    <p className="room-code">{hostPayload.roomCode}</p>
                    <button type="button" className="btn-link" onClick={copyRoomCode}>Copy ID</button>
                  </div>
                )}
              </section>

              <section className="lobby-card" aria-labelledby="guest-heading">
                <p className="lobby-card__eyebrow">For patients</p>
                <div className="lobby-card__head">
                  <div className="role-icon role-icon--guest" aria-hidden>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                      <path d="M12 11.5C14.2091 11.5 16 9.70914 16 7.5C16 5.29086 14.2091 3.5 12 3.5C9.79086 3.5 8 5.29086 8 7.5C8 9.70914 9.79086 11.5 12 11.5Z" />
                      <path d="M4.5 20.5C4.5 16.634 7.63401 13.5 11.5 13.5H12.5C16.366 13.5 19.5 16.634 19.5 20.5" />
                    </svg>
                  </div>
                  <div>
                    <h2 id="guest-heading">Patient</h2>
                    <p className="lobby-card__text">
                      Enter the meeting ID you received from your clinician.
                    </p>
                  </div>
                </div>
                <label className="label" htmlFor="meeting-id">Meeting ID</label>
                <input
                  id="meeting-id"
                  className="input input--meeting"
                  type="text"
                  autoComplete="off"
                  inputMode="text"
                  placeholder="e.g. ABC12XY8"
                  value={guestCode}
                  onChange={(e) => setGuestCode(e.target.value)}
                  disabled={busy}
                />
                <div className="lobby-card__actions lobby-card__actions--single">
                  <button type="button" className="primary lobby-btn-main" onClick={handlePatientJoinRequest} disabled={busy || !guestCode.trim()}>
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
                Allow camera and microphone when your browser asks — needed for the video visit.
              </p>
            </footer>
          </div>

          {/* Post-call recording */}
          {recordedBlob && (
            <section className="recording-panel" aria-label="Call recording">
              <div className="recording-panel__inner">
                <div className="recording-panel__head">
                  <h2 className="recording-panel__title">Call recording</h2>
                  {roomCode && <span className="recording-panel__meta">Meeting {roomCode}</span>}
                </div>
                <audio controls src={recordingUrl} className="recording-player" />
                <div className="recording-downloads">
                  <p className="recording-downloads__label">Download as:</p>
                  <div className="recording-downloads__btns">
                    <button type="button" className="dl-btn" onClick={() => downloadAs("webm")} disabled={isConverting}>WebM</button>
                    <button type="button" className="dl-btn" onClick={() => downloadAs("mp3")} disabled={isConverting}>
                      {convertingFormat === "mp3" ? "Converting…" : "MP3"}
                    </button>
                    <button type="button" className="dl-btn" onClick={() => downloadAs("mp4")} disabled={isConverting}>
                      {convertingFormat === "mp4" ? "Converting…" : "MP4"}
                    </button>
                  </div>
                </div>
                {(isConverting || ffmpegLoading) && (
                  <p className="recording-converting-hint">
                    {ffmpegLoading ? "Loading audio converter (~30 MB, one-time)…" : `Converting to ${convertingFormat?.toUpperCase()}…`}
                  </p>
                )}
              </div>
            </section>
          )}
        </>
      )}

      {/* ── In-call UI ── */}
      {inCall && (
        <>
          <header className="meeting-topbar">
            <div className="meeting-topbar__left">
              <div className="app-logo app-logo--sm" aria-hidden />
              <div>
                <div className="meeting-topbar__title">Telehealth appointment</div>
                <div className="meeting-topbar__meta">
                  <span className="meeting-topbar__id-group">
                    <span className="mono-id">{roomCode}</span>
                    <span className="meeting-topbar__sep">·</span>
                  </span>
                  <span>{mediaConnected ? "Connected" : "Connecting…"}</span>
                  <span className="meeting-topbar__sep">·</span>
                  <span>
                    {remoteOthersCount > 0
                      ? remoteOthersCount === 1 ? "1 other" : `${remoteOthersCount} others`
                      : "Waiting for others"}
                  </span>
                </div>
              </div>
            </div>
            <div className="meeting-topbar__right">
              <button type="button" className="ghost btn-toolbar-text" onClick={copyMeetingId}>Copy ID</button>
            </div>
          </header>

          <div className="meeting-workspace">
            <div className="meeting-main">
              <div className="video-gallery" role="list" aria-label="Video feeds">
                {participants.map((p) => {
                  const stream = streamByAttendeeId.get(p.attendeeId);
                  const live = showParticipantVideo(p);
                  const label = videoLabelForParticipant(p);
                  return (
                    <div key={p.attendeeId} className={`video-cell ${p.isSelf ? "video-cell--self" : ""}`} role="listitem">
                      {stream && (
                        <VideoTile stream={stream} localTile={p.isSelf} label={label} visible={live} />
                      )}
                      {!live && (
                        <div className="video-placeholder">
                          <div className="video-placeholder__avatar">{initialsFromDisplayName(p.displayName)}</div>
                          <div className="video-placeholder__name">{label}</div>
                          <div className="video-placeholder__status">
                            {p.isSelf && localCamOn && !stream ? "Starting camera…"
                              : p.isSelf && !localCamOn ? "Your camera is off"
                              : "Camera off"}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="meeting-toolbar" role="toolbar" aria-label="Call controls">
                <button type="button" className={`toolbar-btn ${micMuted ? "toolbar-btn--off" : ""}`} onClick={toggleMic} aria-pressed={micMuted}>
                  <span className="toolbar-btn__icon">{micMuted ? <MicOffIcon /> : <MicOnIcon />}</span>
                  <span className="toolbar-btn__label">{micMuted ? "Unmute" : "Mute"}</span>
                </button>
                <button type="button" className={`toolbar-btn ${!localCamOn ? "toolbar-btn--off" : ""}`} onClick={toggleCamera} aria-pressed={!localCamOn}>
                  <span className="toolbar-btn__icon">{localCamOn ? <CamOnIcon /> : <CamOffIcon />}</span>
                  <span className="toolbar-btn__label">{localCamOn ? "Stop cam" : "Start cam"}</span>
                </button>
                <button type="button" className="toolbar-btn toolbar-btn--danger" onClick={leave}>
                  <span className="toolbar-btn__icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
                      <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.1-1.1a2 2 0 0 1 2.11-.45 12 12 0 0 0 3.7.7 2 2 0 0 1 2 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 3.12 4.18 2 2 0 0 1 5 2h3a2 2 0 0 1 2 1.72 12 12 0 0 0 .7 3.7 2 2 0 0 1-.45 2.11z" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  </span>
                  <span className="toolbar-btn__label">Leave</span>
                </button>
              </div>
            </div>

            {/* Recording sidebar */}
            <aside className="meeting-sidebar" aria-label="Recording status">
              <div className="rec-status-panel">
                <div className="rec-status-panel__header">
                  <span className="rec-badge">
                    <span className={`rec-dot ${recording ? "rec-dot--live" : ""}`} />
                    {recording ? "Recording" : "Initialising…"}
                  </span>
                  {recording && <span className="rec-timer">{formatDuration(recordingDuration)}</span>}
                </div>
                <p className="rec-status-panel__hint">
                  Both voices are captured automatically and available for playback after the visit.
                </p>
                {recordingError && <p className="rec-error" role="alert">{recordingError}</p>}
              </div>
            </aside>
          </div>

          {/* ── Admit toasts — floating, doctor only ── */}
          {visitContext?.role === "doctor" && pendingKnocks.length > 0 && (
            <div className="admit-toasts" role="alert" aria-live="polite">
              {pendingKnocks.map((knock) => (
                <div key={knock.knockId} className="admit-toast">
                  <div className="admit-toast__info">
                    <span className="admit-toast__dot" aria-hidden />
                    <span className="admit-toast__text">Patient is waiting to join</span>
                  </div>
                  <div className="admit-toast__actions">
                    <button type="button" className="admit-toast__deny" onClick={() => denyKnock(knock.knockId)}>Deny</button>
                    <button type="button" className="admit-toast__admit" onClick={() => admitKnock(knock.knockId)}>Admit</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
