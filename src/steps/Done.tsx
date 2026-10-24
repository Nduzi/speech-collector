import { useState } from "react";
import { CONTACT_EMAIL, DEFAULT_ROUNDS, MAX_ROUNDS, PROMPTS } from "../config";
import { Icon } from "../icons";
import { QueueStatus, UploadQueue } from "../lib/queue";
import { Session, doneCount, shortId } from "../lib/session";

export function Done({ session, queue, status, canAddMore, onMore, onForget }: { session: Session; queue: UploadQueue; status: QueueStatus; canAddMore: boolean; onMore: () => void; onForget: () => void }) {
  const [copied, setCopied] = useState(false);
  const pending = status.waiting > 0;
  const stuck = status.failed > 0;
  const copy = async () => { try { await navigator.clipboard.writeText(session.speakerId); setCopied(true); } catch { /* the id is also shown on screen */ } };
  return (
    <section className="sheet pad">
      <p className="eyebrow">{pending ? "Almost there" : "All saved"}</p>
      <h1>{pending ? "Sending your recordings…" : `Thank you, ${session.name}!`}</h1>
      <p className="lead">You recorded <b className="num">{doneCount(session)}</b> words in <b className="num">{session.targetRounds}</b> rounds. That is a real help to the project.</p>

      {pending && !stuck && <div className="note" role="status">Please keep this page open until it says <b>All saved</b>. <span className="num">{status.waiting}</span> left to send.</div>}
      {pending && stuck && (
        <div className="note bad" role="alert">{status.waiting} recording{status.waiting === 1 ? "" : "s"} could not be sent yet. Check your connection, then try again. Keep this page open; they are stored safely on this device meanwhile.
          <div className="row"><button className="btn primary" onClick={() => queue.retryNow()}><Icon n="refresh" /> Try again</button></div></div>
      )}
      {!pending && <div className="note ok" role="status"><Icon n="check" /> Everything has been sent. You can close this page.</div>}

      <h2>Your participant ID</h2>
      <p className="muted small">Keep this if you ever want your recordings removed. Email it to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and we will delete everything linked to it.</p>
      <div className="idbox"><code>{session.speakerId}</code><button className="btn small" onClick={copy}><Icon n="copy" /> {copied ? "Copied" : "Copy"}</button></div>
      <p className="muted small">Short form: <b className="num">{shortId(session.speakerId)}</b></p>

      {canAddMore && (
        <div className="more">
          <h2>Want to give a little more?</h2>
          <p>Extra rounds help a lot, especially if you can do them later, at a different time, or in a different place. Up to {MAX_ROUNDS} rounds in all. Entirely optional.</p>
          <button className="btn big" onClick={onMore} disabled={pending}>Record {Math.min(DEFAULT_ROUNDS, MAX_ROUNDS - session.targetRounds)} more rounds ({Math.min(DEFAULT_ROUNDS, MAX_ROUNDS - session.targetRounds) * PROMPTS.length} words)</button>
        </div>
      )}

      <p className="muted small">Someone else sharing this device? <button className="link" onClick={() => { if (!pending || confirm("Some recordings are still being sent. Start a new participant anyway?")) onForget(); }}>Start a new participant</button></p>
    </section>
  );
}
