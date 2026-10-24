import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_RETRIES_BEFORE_ACCEPT, TARGET_SR } from "../config";
import { LevelMeter } from "../components";
import { Icon, PenCircle } from "../icons";
import { RecordingRow } from "../lib/api";
import { Endpointer, encodeWav } from "../lib/endpointer";
import { MicHandle } from "../lib/mic";
import { analyse } from "../lib/quality";
import { Job, UploadQueue } from "../lib/queue";
import { resample } from "../lib/resample";
import { Session, roundOrder, takeKey } from "../lib/session";

type Phase = "arming" | "listening" | "hearing" | "processing" | "saved" | "retry" | "paused" | "lost";
type Note = { kind: "warn" | "retry"; text: string } | null;

const HOLD_MS = 6000; // an accepted take can be undone for this long before it is sent

interface Props {
  session: Session;
  mic: MicHandle;
  queue: UploadQueue;
  onSession: (s: Session) => void;
  onRoundDone: () => void;
  onStop: () => void;
}

export function Recorder({ session, mic, queue, onSession, onRoundDone, onStop }: Props) {
  const plan = useMemo(() => roundOrder(session.speakerId, session.round), [session.speakerId, session.round]);
  const sRef = useRef(session);
  sRef.current = session;
  const keyOf = (i: number) => takeKey(session.speakerId, plan[i].label, session.round);
  const [cursor, setCursor] = useState(() => plan.findIndex((p) => !session.done[takeKey(session.speakerId, p.label, session.round)]));
  const [phase, setPhase] = useState<Phase>("arming");
  const [note, setNote] = useState<Note>(null);
  const [heldKey, setHeldKey] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const epRef = useRef<Endpointer | null>(null);
  const level = useRef(-90);
  const floor = useRef(-90);
  const retries = useRef(0);
  const held = useRef<{ job: Job; idx: number; tries: number } | null>(null);
  const timers = useRef<{ hold?: ReturnType<typeof setTimeout>; advance?: ReturnType<typeof setTimeout>; retry?: ReturnType<typeof setTimeout> }>({});
  const onUtt = useRef<(u: any) => void>(() => undefined);

  function commitHeld() {
    const h = held.current;
    if (!h) return;
    held.current = null;
    clearTimeout(timers.current.hold);
    void queue.add(h.job);
    const s = sRef.current;
    onSession({ ...s, done: { ...s.done, [h.job.key]: 1 }, retries: { ...s.retries, [h.job.key]: h.tries } });
    setHeldKey(null);
  }

  // ---- one endpointer for the lifetime of the screen
  useEffect(() => {
    const ep = new Endpointer(mic.sampleRate, { hangoverMs: 600, maxDurationMs: 4000, noSpeechTimeoutMs: 0 }, {
      onState: (st) => { if (st === "speech") setPhase("hearing"); },
      onLevel: (l, f) => { level.current = l; floor.current = f; },
      onUtterance: (u) => onUtt.current(u),
    });
    epRef.current = ep;
    mic.handler = (c) => ep.push(c);
    const hide = () => commitHeld();
    window.addEventListener("pagehide", hide);
    return () => {
      window.removeEventListener("pagehide", hide);
      ep.stop();
      mic.handler = () => undefined;
      Object.values(timers.current).forEach((t) => clearTimeout(t));
      commitHeld();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mic]);

  // ---- listen for the current word
  useEffect(() => {
    if (cursor < 0) { onRoundDone(); return; }
    setPhase("arming");
    epRef.current!.listen();
    const t = setTimeout(() => setPhase((p) => (p === "arming" ? "listening" : p)), 450); // noise-floor calibration
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, tick]);

  // ---- the microphone can disappear (phone locked, headset unplugged)
  useEffect(() => {
    const t = setInterval(() => {
      if (!mic.active && phaseRef.current !== "lost") { epRef.current?.stop(); setPhase("lost"); }
    }, 1000);
    return () => clearInterval(t);
  }, [mic]);

  onUtt.current = (u) => {
    if (cursor < 0) return;
    setPhase("processing");
    const s = sRef.current;
    const p = plan[cursor];
    const x = resample(u.samples, u.sampleRate, TARGET_SR);
    const q = analyse(x, TARGET_SR);
    const tries = retries.current;
    if (q.blocking && (tries < MAX_RETRIES_BEFORE_ACCEPT || q.durationMs < 100)) {
      retries.current++;
      setNote({ kind: "retry", text: q.message });
      setPhase("retry");
      timers.current.retry = setTimeout(() => setTick((t) => t + 1), 1200);
      return;
    }
    const key = takeKey(s.speakerId, p.label, s.round);
    const row: RecordingRow = {
      speaker_id: s.speakerId, label: p.label, round: s.round, storage_path: `${key}.wav`,
      sample_rate: TARGET_SR, native_sample_rate: u.sampleRate, duration_ms: q.durationMs, peak_dbfs: q.peakDbfs, rms_dbfs: q.rmsDbfs,
      noise_floor_dbfs: q.noiseFloorDbfs, snr_db: q.snrDb, clipped_fraction: Math.round(q.clippedFraction * 1e5) / 1e5,
      quality_flag: q.flag, retries: tries, device_label: mic.describe(), endpoint_reason: u.reason,
    };
    commitHeld();
    held.current = { job: { key, row, wav: encodeWav(x, TARGET_SR), attempts: 0 }, idx: cursor, tries };
    setHeldKey(key);
    clearTimeout(timers.current.hold);
    timers.current.hold = setTimeout(commitHeld, HOLD_MS);
    retries.current = 0;
    setNote(q.blocking ? { kind: "warn", text: "Saved, but it was not very clear. That is OK." } : q.flag === "noisy" ? { kind: "warn", text: q.message } : null);
    setPhase("saved");
    const idx = cursor;
    timers.current.advance = setTimeout(() => {
      const doneNow = (i: number) => i === idx || !!sRef.current.done[takeKey(s.speakerId, plan[i].label, s.round)] || held.current?.job.key === takeKey(s.speakerId, plan[i].label, s.round);
      setCursor(plan.findIndex((_, i) => i > idx && !doneNow(i)));
    }, 650);
  };

  function undo() {
    const h = held.current;
    if (!h) return;
    clearTimeout(timers.current.hold);
    clearTimeout(timers.current.advance);
    clearTimeout(timers.current.retry);
    held.current = null;
    setHeldKey(null);
    setNote(null);
    retries.current = 0;
    if (h.idx === cursor) setTick((t) => t + 1);
    else setCursor(h.idx);
  }

  function pause() {
    clearTimeout(timers.current.retry);
    clearTimeout(timers.current.advance);
    epRef.current?.stop();
    setPhase("paused");
  }

  function manual() {
    const ep = epRef.current!;
    if (ep.state === "speech") ep.forceStop();
    else { ep.forceStart(); setPhase("hearing"); }
  }

  async function restartMic() {
    try { await mic.open(); setTick((t) => t + 1); } catch { /* the message below stays up */ }
  }

  if (cursor < 0) return <section className="sheet pad"><p>Round complete…</p></section>;
  const p = plan[cursor];
  const status: Record<Phase, string> = {
    arming: "Get ready…", listening: `Listening — say “${p.spoken}”`, hearing: "Hearing you…", processing: "Checking…",
    saved: "Saved", retry: note?.text ?? "Please try again", paused: "Paused", lost: "The microphone stopped",
  };
  const cls = phase === "listening" ? "go" : phase === "hearing" ? "hear" : phase === "saved" ? "saved" : phase === "retry" || phase === "lost" ? "retry" : "";

  return (
    <div className="recorder">
      <section className={`slate ${cls}`} aria-live="polite">
        <div className="slate-bar" aria-hidden />
        <div className="slate-meta num"><span>Round {session.round} of {session.targetRounds}</span><span>Word {cursor + 1} of {plan.length}</span></div>
        <div className="slate-kind">{p.kind === "letter" ? "the letter" : "the number"}</div>
        <div className="glyph" aria-hidden>{p.shown}</div>
        <div className="say">Say just <b>“{p.spoken}”</b></div>
        <div className={`slate-status ${cls}`}>
          {phase === "saved" && <Icon n="check" />}{phase === "retry" && <Icon n="warn" />}
          <span>{status[phase]}</span>
        </div>
        {phase === "saved" && note?.kind === "warn" && <div className="slate-note">{note.text}</div>}
        <LevelMeter levelRef={level} floorRef={floor} label="Microphone level" />
      </section>

      <ol className="grid16" aria-label="This round">
        {plan.map((q, i) => {
          const k = keyOf(i);
          const done = !!session.done[k] || heldKey === k;
          return (
            <li key={q.label} className={`${done ? "done" : ""} ${i === cursor ? "now" : ""}`} aria-current={i === cursor ? "step" : undefined}>
              {done && <PenCircle />}<span>{q.shown}</span>
            </li>
          );
        })}
      </ol>

      {phase === "paused" && (
        <div className="note" role="status">Paused. Nothing is being recorded.
          <div className="row"><button className="btn primary" onClick={() => setTick((t) => t + 1)}><Icon n="play" /> Resume</button><button className="btn" onClick={onStop}>Stop for now</button></div></div>
      )}
      {phase === "lost" && (
        <div className="note bad" role="alert">The microphone stopped, probably because the screen locked or the headset was unplugged.
          <div className="row"><button className="btn primary" onClick={restartMic}><Icon n="mic" /> Turn the microphone back on</button><button className="btn" onClick={onStop}>Stop for now</button></div></div>
      )}

      <div className="controls">
        <button className="btn" onClick={undo} disabled={!heldKey} title="Re-record the word you just did"><Icon n="undo" /> Redo last</button>
        <button className="btn" onClick={pause} disabled={phase === "paused" || phase === "lost"}><Icon n="pause" /> Pause</button>
        <button className="btn" onClick={manual} disabled={phase === "paused" || phase === "lost" || phase === "processing" || phase === "saved"}>
          {phase === "hearing" ? <><Icon n="stop" /> Stop</> : <><Icon n="mic" /> Record by hand</>}</button>
        <span className="sp" />
        <button className="btn ghost" onClick={onStop}>Stop for now</button>
      </div>
      <p className="muted small">It starts by itself when you speak. If it does not pick you up, press “Record by hand”, say the word, then press Stop.</p>
    </div>
  );
}
