import { useCallback, useEffect, useRef, useState } from "react";
import { CONTACT_EMAIL, DEFAULT_ROUNDS, MAX_ROUNDS, PROJECT_NAME, PROMPTS } from "./config";
import { supabaseApi } from "./lib/api";
import { MicHandle } from "./lib/mic";
import { UploadQueue, QueueStatus, indexedDbStore } from "./lib/queue";
import { Session, doneCount, isExpired, loadSession, saveSession, totalTakes } from "./lib/session";
import { Logo } from "./icons";
import { Consent } from "./steps/Consent";
import { About } from "./steps/About";
import { MicCheck } from "./steps/MicCheck";
import { Recorder } from "./steps/Recorder";
import { Done } from "./steps/Done";

const queue = new UploadQueue(supabaseApi, indexedDbStore());
const mic = new MicHandle();

type Step = "consent" | "about" | "back" | "mic" | "record" | "break" | "done";

export function useQueueStatus(): QueueStatus {
  const [s, set] = useState<QueueStatus>(queue.status());
  useEffect(() => queue.onChange(set), []);
  return s;
}

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [expired, setExpired] = useState(() => { const s = loadSession(); return !!s && isExpired(s); });
  const [step, setStep] = useState<Step>(() => {
    const s = loadSession();
    if (!s || isExpired(s)) return "consent";
    return s.finished ? "done" : "back";
  });
  const q = useQueueStatus();
  const ref = useRef(session);
  ref.current = session;

  const update = useCallback((s: Session | null) => { setSession(s); saveSession(s); }, []);

  useEffect(() => {
    void queue.restore();
    const online = () => queue.retryNow();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (queue.status().waiting > 0) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [step]);
  // the microphone is released whenever we are not on a screen that needs it
  useEffect(() => { if (step !== "mic" && step !== "record") mic.close(); }, [step]);

  const stopForNow = () => { mic.close(); setStep(ref.current?.finished ? "done" : "back"); };
  const startOver = () => { update(null); setExpired(false); setStep("consent"); };

  const progress = session ? `${doneCount(session)} / ${totalTakes(session)}` : "";

  return (
    <div className="shell">
      <header className="top">
        <div className="brand"><Logo /><span>{PROJECT_NAME}</span></div>
        {session && step !== "done" && step !== "consent" && step !== "about" && <span className="num muted" title="Recordings so far">{progress}</span>}
      </header>
      <main>
        {expired && step === "consent" && (
          <div className="note warn" role="status">Your earlier session ended (sessions stay open for 3 days). Anything you already recorded was kept. You are welcome to start again below.</div>
        )}
        {step === "consent" && <Consent onAgree={() => setStep("about")} />}
        {step === "about" && <About onBack={() => setStep("consent")} onRegistered={(s) => { update(s); setStep("mic"); }} />}
        {step === "back" && session && (
          <section className="sheet pad">
            <h1>Welcome back{session.name ? `, ${session.name}` : ""}</h1>
            <p>You have recorded <b className="num">{doneCount(session)}</b> of <b className="num">{totalTakes(session)}</b> so far. Carry on where you stopped, in the same quiet spot and with the same microphone if you can.</p>
            <div className="row">
              <button className="btn primary big" onClick={() => setStep("mic")}>Continue recording</button>
              <button className="btn ghost" onClick={() => { if (confirm("Start again as a new participant? Your earlier recordings stay with the project.")) startOver(); }}>That is not me</button>
            </div>
            {q.waiting > 0 && <p className="muted small">{q.waiting} recording{q.waiting === 1 ? "" : "s"} still to send; they will go as soon as you are online.</p>}
          </section>
        )}
        {step === "mic" && session && <MicCheck mic={mic} onReady={() => setStep("record")} onStop={stopForNow} />}
        {step === "record" && session && (
          <Recorder
            session={session} mic={mic} queue={queue}
            onSession={update}
            onRoundDone={() => {
              const s = ref.current!;
              if (s.round >= s.targetRounds) { update({ ...s, finished: true }); setStep("done"); }
              else setStep("break");
            }}
            onStop={stopForNow}
          />
        )}
        {step === "break" && session && (
          <section className="sheet pad">
            <h1>Round {session.round} done</h1>
            <p>{session.targetRounds - session.round} more to go. Have a sip of water if you like, then carry on.</p>
            <div className="row">
              <button className="btn primary big" onClick={() => { update({ ...session, round: session.round + 1 }); setStep("record"); }}>Start round {session.round + 1}</button>
              <button className="btn" onClick={() => { update({ ...session, round: session.round + 1 }); stopForNow(); }}>Stop for now</button>
            </div>
            <p className="muted small">If you stop now you can pick this up again from the same link within 3 days.</p>
          </section>
        )}
        {step === "done" && session && (
          <Done
            session={session} queue={queue} status={q}
            canAddMore={session.targetRounds < MAX_ROUNDS}
            onMore={() => { const t = Math.min(MAX_ROUNDS, session.targetRounds + DEFAULT_ROUNDS); update({ ...session, targetRounds: t, round: session.targetRounds + 1, finished: false }); setStep("mic"); }}
            onForget={startOver}
          />
        )}
      </main>
      <footer className="foot">
        <span>{PROMPTS.length} words · letters A–H and numbers 1–8</span>
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </footer>
    </div>
  );
}
