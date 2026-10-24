import { useEffect, useRef, useState } from "react";
import { LevelMeter, dbOfChunk } from "../components";
import { Icon } from "../icons";
import { MicError, describeMicError, listInputs } from "../lib/capture";
import { MicHandle } from "../lib/mic";

type Phase = "idle" | "opening" | "live" | "error";

export function MicCheck({ mic, onReady, onStop }: { mic: MicHandle; onReady: () => void; onStop: () => void }) {
  const [phase, setPhase] = useState<Phase>(mic.active ? "live" : "idle");
  const [err, setErr] = useState<MicError | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [heard, setHeard] = useState(false);
  const [floor, setFloor] = useState<number | null>(null);
  const [stuck, setStuck] = useState(false);
  const level = useRef(-90);
  const floorRef = useRef(-90);
  const hist = useRef<number[]>([]);

  useEffect(() => {
    mic.handler = (c) => {
      const d = dbOfChunk(c);
      level.current = d;
      const h = hist.current;
      h.push(d);
      if (h.length > 1100) h.shift();
    };
    const t = setInterval(() => {
      const h = hist.current;
      if (h.length < 100) return;
      const s = [...h].sort((a, b) => a - b);
      const fl = s[Math.floor(s.length * 0.2)];
      floorRef.current = fl;
      setFloor(fl);
      if (s[s.length - 1] > Math.max(fl + 14, -50)) setHeard(true);
    }, 250);
    return () => { clearInterval(t); mic.handler = () => undefined; };
  }, [mic]);

  async function open(id?: string) {
    setPhase("opening");
    setErr(null);
    hist.current = [];
    setHeard(false);
    try {
      await mic.open(id);
      setPhase("live");
      setDevices(await listInputs()); // labels only appear after permission was granted
    } catch (e) {
      setErr(e instanceof MicError ? e : describeMicError(e));
      setPhase("error");
    }
  }
  useEffect(() => { if (mic.active) void listInputs().then(setDevices); }, [mic]);
  // a very quiet microphone must not trap anyone on this screen
  useEffect(() => {
    if (phase !== "live" || heard) { setStuck(false); return; }
    const t = setTimeout(() => setStuck(true), 12000);
    return () => clearTimeout(t);
  }, [phase, heard]);

  const verdict = floor == null ? null : floor < -58 ? { cls: "ok", t: "Nice and quiet." } : floor < -46 ? { cls: "ok", t: "A little background sound, which is fine." } : { cls: "warn", t: "Quite noisy here. A quieter spot gives better recordings." };

  return (
    <section className="sheet pad">
      <h1>Check your microphone</h1>
      {phase !== "live" && (
        <>
          <p className="lead">Choose <b>Allow</b> when your browser asks to use the microphone. Nothing is recorded until the next screen, and recordings go only to this project.</p>
          <ul className="tips">
            <li>Find a quiet spot.</li>
            <li>Use the <b>same microphone</b> for the whole session.</li>
            <li>Speak at a normal pace, as if reading out a code.</li>
          </ul>
          {err && <div className="note bad" role="alert">{err.message}</div>}
          <div className="row">
            <button className="btn primary big" onClick={() => open(deviceId || undefined)} disabled={phase === "opening"}><Icon n="mic" /> {phase === "opening" ? "Waiting for permission…" : err ? "Try again" : "Use my microphone"}</button>
            <button className="btn ghost" onClick={onStop}>Not now</button>
          </div>
        </>
      )}
      {phase === "live" && (
        <>
          <p className="lead">Say <b>“A”</b> out loud.</p>
          <LevelMeter levelRef={level} floorRef={floorRef} />
          <div className="status-line" aria-live="polite">
            {heard ? <span className="ok"><Icon n="check" /> I can hear you.</span> : <span className="muted">Waiting for your voice…</span>}
            {verdict && <span className={verdict.cls}>{verdict.t}</span>}
          </div>
          {devices.length > 1 && (
            <label className="f"><span>Microphone</span>
              <select value={deviceId} onChange={(e) => { setDeviceId(e.target.value); void open(e.target.value || undefined); }}>
                <option value="">Default microphone</option>
                {devices.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
              </select></label>
          )}
          <p className="muted small">Using {mic.label || "the default microphone"}.</p>
          <div className="row">
            <button className="btn primary big" disabled={!heard && !stuck} onClick={onReady}>{heard ? "Start recording" : stuck ? "Continue anyway" : "Start recording"}</button>
            <button className="btn ghost" onClick={onStop}>Stop for now</button>
          </div>
          {!heard && <p className="muted small">Bar not moving? Close any other app that uses the microphone, or pick a different microphone if the list shows more than one.</p>}
        </>
      )}
    </section>
  );
}
