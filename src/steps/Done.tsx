import { useState } from "react";
import { CONTACT_EMAIL, DEFAULT_ROUNDS, MAX_ROUNDS, PROMPTS } from "../config";
import { Icon } from "../icons";
import { QueueStatus, UploadQueue } from "../lib/queue";
import { Session, doneCount, shortId } from "../lib/session";

export function Done({ session, queue, status, canAddMore, onMore, onForget, missing, onCatchUp }: { session: Session; queue: UploadQueue; status: QueueStatus; canAddMore: boolean; onMore: () => void; onForget: () => void; missing: number; onCatchUp: () => void }) {
  const [copied, setCopied] = useState(false);
  const pending = status.waiting > 0;
  const stuck = status.failed > 0;
  const copy = async () => { try { await navigator.clipboard.writeText(session.speakerId); setCopied(true); } catch { /* the id is also shown on screen */ } };
  return (
    <section className="sheet pad">
      <h1>{pending ? "Sending your recordings…" : `Thank you, ${session.name}!`}</h1>
      <p className="lead">You made <b className="num">{doneCount(session)}</b> recordings in <b className="num">{session.targetRounds}</b> rounds. That’s a real help to the project.</p>

      {pending && !stuck && <div className="note" role="status">Keep this page open until all your recordings are sent. <span className="num">{status.waiting}</span> still to go.</div>}
      {pending && stuck && (
        <div className="note bad" role="alert">{status.waiting} recording{status.waiting === 1 ? " hasn’t" : "s haven’t"} been sent. Check your internet connection and try again. {status.waiting === 1 ? "It’s" : "They’re"} saved on this device and will send when you open this link again with a connection.
          <div className="row"><button className="btn primary" onClick={() => queue.retryNow()}><Icon n="refresh" /> Try again</button></div></div>
      )}
      {!pending && <div className="note ok" role="status"><Icon n="check" /> All recordings sent. You can close this page.</div>}

      {missing > 0 && !pending && (
        <div className="note">
          <div>
            <b>One more thing.</b> I’ve added the chess piece names (king, queen, rook, bishop, knight and pawn) since you started. Could you say those too? It’s {missing} more recording{missing === 1 ? "" : "s"}, about {Math.max(1, Math.round((missing * 4.5) / 60))} minute{Math.round((missing * 4.5) / 60) > 1 ? "s" : ""}.
            <div className="row"><button className="btn primary big" onClick={onCatchUp}>Record the chess pieces</button></div>
          </div>
        </div>
      )}

      <h2>Your participant ID</h2>
      <p className="muted small">Keep this ID. To have your recordings removed, email it to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and I’ll delete everything linked to it.</p>
      <div className="idbox"><code>{session.speakerId}</code><button className="btn small" onClick={copy}><Icon n="copy" /> {copied ? "Copied" : "Copy"}</button></div>
      <p className="muted small">Short version: <b className="num">{shortId(session.speakerId)}</b></p>

      {canAddMore && (
        <div className="more">
          <h2>Want to do more?</h2>
          <p>Extra rounds help most when you record them at a different time or in a different place. You can do up to {MAX_ROUNDS} rounds in total. It’s entirely optional.</p>
          <button className="btn big" onClick={onMore} disabled={pending}>Record {Math.min(DEFAULT_ROUNDS, MAX_ROUNDS - session.targetRounds)} more rounds ({Math.min(DEFAULT_ROUNDS, MAX_ROUNDS - session.targetRounds) * PROMPTS.length} recordings)</button>
        </div>
      )}

      <p className="muted small">Is someone else using this device? <button className="link" onClick={() => { if (!pending || confirm("Some recordings are still being sent. Start a new participant anyway? Keep this page open until they finish.")) onForget(); }}>Start a new participant</button></p>
    </section>
  );
}
