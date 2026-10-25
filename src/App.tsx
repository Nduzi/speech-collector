import { useCallback, useEffect, useRef, useState } from "react";
import { CONTACT_EMAIL, DEFAULT_ROUNDS, MAX_ROUNDS, PROJECT_NAME } from "./config";
import { supabaseApi } from "./lib/api";
import { MicHandle } from "./lib/mic";
import { UploadQueue, QueueStatus, indexedDbStore } from "./lib/queue";
import { Session, doneCount, firstOpenRound, isExpired, missingPieces, loadSession, saveSession, totalTakes } from "./lib/session";
import { parseResumeLink, sessionFromLink } from "./lib/resume";
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

/** Open the saved session, or one built from a "finish what is missing" link the owner sent (see lib/resume.ts).
 *  Idempotent: React may call it twice, and a link never overwrites progress already saved on this device. */
function startingSession(): { session: Session | null; fromLink: boolean } {
  const link = parseResumeLink(location.search);
  const saved = loadSession();
  if (link) {
    if (saved && saved.speakerId === link.speakerId && !isExpired(saved)) return { session: saved, fromLink: true };
    const s = sessionFromLink(link);
    saveSession(s);
    return { session: s, fromLink: true };
  }
  return { session: saved, fromLink: false };
}

export function App() {
  const [start] = useState(startingSession);
  const [session, setSession] = useState<Session | null>(start.session);
  const [expired, setExpired] = useState(() => !start.fromLink && !!start.session && isExpired(start.session));
  const [step, setStep] = useState<Step>(() => {
    const s = start.session;
    if (!s || (!start.fromLink && isExpired(s))) return "consent";
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
  // the link has done its job; drop it from the address bar so a refresh cannot rebuild the session
  useEffect(() => { if (start.fromLink) { const keep = new URLSearchParams(location.search).get("c"); history.replaceState(null, "", location.pathname + (keep ? `?c=${encodeURIComponent(keep)}` : "")); } }, [start.fromLink]);
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
          <div className="note warn" role="status">Your earlier session has closed, because sessions last 3 days. Everything you already recorded was kept. You’re welcome to start again below.</div>
        )}
        {step === "consent" && <Consent onAgree={() => setStep("about")} onResume={(s) => { update(s); setExpired(false); setStep(s.finished ? "done" : "back"); }} />}
        {step === "about" && <About onBack={() => setStep("consent")} onRegistered={(s) => { update(s); setStep("mic"); }} />}
        {step === "back" && session && (
          <section className="sheet pad">
            <h1>Welcome back{session.name ? `, ${session.name}` : ""}</h1>
            <p>You’ve recorded <b className="num">{doneCount(session)}</b> of <b className="num">{totalTakes(session)}</b>. Carry on where you stopped, ideally with the same microphone and in a similarly quiet spot.</p>
            {missingPieces(session) > 0 && <p>Since you started I’ve added the chess piece names (king, queen, rook, bishop, knight and pawn), so I’d love you to say those too.</p>}
            <div className="row">
              <button className="btn primary big" onClick={() => setStep("mic")}>Continue recording</button>
              <button className="btn ghost" onClick={() => { if (confirm("Start again as a new participant? Your earlier recordings stay with the project.")) startOver(); }}>That’s not me</button>
            </div>
            {q.waiting > 0 && <p className="muted small">{q.waiting} recording{q.waiting === 1 ? " hasn’t" : "s haven’t"} been sent yet. {q.waiting === 1 ? "It’ll" : "They’ll"} go as soon as you’re back online.</p>}
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
            <p>{session.targetRounds - session.round} more round{session.targetRounds - session.round === 1 ? "" : "s"} to go. Take a breather if you like.</p>
            <div className="row">
              <button className="btn primary big" onClick={() => { update({ ...session, round: session.round + 1 }); setStep("record"); }}>Start round {session.round + 1}</button>
              <button className="btn" onClick={() => { update({ ...session, round: session.round + 1 }); stopForNow(); }}>Stop for now</button>
            </div>
            <p className="muted small">Stopping now is fine. Open this link on this device within 3 days to carry on.</p>
          </section>
        )}
        {step === "done" && session && (
          <Done
            session={session} queue={queue} status={q}
            canAddMore={session.targetRounds < MAX_ROUNDS}
            onMore={() => { const t = Math.min(MAX_ROUNDS, session.targetRounds + DEFAULT_ROUNDS); update({ ...session, targetRounds: t, round: session.targetRounds + 1, finished: false }); setStep("mic"); }}
            missing={missingPieces(session)}
            onCatchUp={() => { update({ ...session, finished: false, round: firstOpenRound(session) }); setStep("mic"); }}
            onForget={startOver}
          />
        )}
      </main>
      <footer className="foot">
        <span>Letters A–H, numbers 1–8 and the chess pieces</span>
        <span>Questions? <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></span>
      </footer>
    </div>
  );
}
