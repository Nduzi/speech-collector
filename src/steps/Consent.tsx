import { useState } from "react";
import { CONTACT_EMAIL, DEFAULT_ROUNDS, ETHICS_REF, INSTITUTION, PROJECT_TITLE, PROMPTS, RESEARCHER } from "../config";
import { fetchProgress } from "../lib/api";
import { UUID, sessionFromProgress } from "../lib/resume";
import { Session } from "../lib/session";

/** For someone who already recorded but is on a new device or browser: carry on with the ID from their thank-you page. */
function ContinueWithId({ onResume }: { onResume: (s: Session) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function go() {
    const id = value.trim().toLowerCase();
    if (!UUID.test(id)) { setErr("That doesn’t look like a participant ID. It has 36 characters, like 2240e01a-94db-4488-a10e-689b0cc1f48e."); return; }
    setBusy(true); setErr("");
    try {
      const p = await fetchProgress(id);
      if (!p) setErr("I couldn’t find that ID. Check it and try again.");
      else if ("withdrawn" in p) setErr("That participant withdrew, so there is nothing to carry on with.");
      else if (!p.window_open) setErr(`Your 3 days to record have ended. Email ${CONTACT_EMAIL} and I’ll send you a new link.`);
      else onResume(sessionFromProgress(id, p));
    } catch {
      setErr("Couldn’t reach the server. Check your internet connection and try again.");
    } finally { setBusy(false); }
  }
  if (!open) return <p className="small">Already recorded some? <button type="button" className="link" onClick={() => setOpen(true)}>Carry on where you left off</button></p>;
  return (
    <div className="note">
      <div style={{ flex: 1 }}>
        <label className="f"><span>Your participant ID</span>
          <input type="text" value={value} onChange={(e) => { setValue(e.target.value); setErr(""); }} placeholder="paste the ID from your thank-you page" autoComplete="off" spellCheck={false} onKeyDown={(e) => { if (e.key === "Enter") void go(); }} />
          <span className="hint">The 36-character code shown on your last screen. Not saved it? Message me and I’ll send you a link.</span></label>
        {err && <p role="alert" style={{ color: "var(--red)", margin: "8px 0 0" }}>{err}</p>}
        <div className="row"><button type="button" className="btn primary" disabled={busy || !value.trim()} onClick={go}>{busy ? "Looking…" : "Carry on"}</button><button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button></div>
      </div>
    </div>
  );
}

export function Consent({ onAgree, onResume }: { onAgree: () => void; onResume: (s: Session) => void }) {
  const [adult, setAdult] = useState(false);
  const [agree, setAgree] = useState(false);
  const minutes = Math.round((DEFAULT_ROUNDS * PROMPTS.length * 4.5) / 60);
  return (
    <section className="sheet pad">
      <ContinueWithId onResume={onResume} />
      <h1>Help a chess board learn to listen</h1>
      <p className="lead">
        Hi there! I’m <b>{RESEARCHER}</b>. For my final-year project at the <b>{INSTITUTION}</b> I’m building <b>{PROJECT_TITLE}</b>: you say a move out loud, like “knight to F three”, and the board moves the piece.
      </p>
      <p>
        Chess squares are named with the letters <b>A to H</b> and the numbers <b>1 to 8</b>, and the pieces are the <b>king, queen, rook, bishop, knight and pawn</b>. The board has to recognise exactly those {PROMPTS.length} words in many different voices, accents and microphones. A few minutes of your voice helps it work for more people. I’d really appreciate it.
      </p>

      <ol className="steps">
        <li><b>Tell me about you.</b> A first name or nickname, plus a few details that affect how voices sound.</li>
        <li><b>Check your microphone.</b> A phone or laptop is fine.</li>
        <li><b>Say each letter, number and chess piece as it appears.</b> That’s {PROMPTS.length} words, in {DEFAULT_ROUNDS} rounds, about <b>{minutes} minutes</b> in a quiet spot. You can stop and carry on later on the same device, within 3 days.</li>
      </ol>

      <details className="info" open>
        <summary>What I collect and what happens to it</summary>
        <ul>
          <li><b>Your voice:</b> recordings of the {PROMPTS.length} words (the letters, the numbers and the chess pieces), plus technical details of each one (length, loudness, microphone name).</li>
          <li><b>About you:</b> a first name or nickname (not your surname), age range, gender, home language, accent or region, country, and the microphone and room you used. For age and gender you can choose “prefer not to say”.</li>
          <li><b>What I don’t collect:</b> your surname, email address, phone number, ID number or location. The services that host this page and the data may keep ordinary technical logs, such as your IP address.</li>
          <li><b>Who sees it:</b> only me. The recordings are used to train and test speech recognition models. They are not published, sold or shared with anyone else.</li>
          <li><b>Where it’s stored:</b> a secured cloud database (Supabase) in Ireland. Only I can get into it.</li>
          <li><b>How long:</b> only as long as the project needs it. Then I delete it.</li>
        </ul>
      </details>

      <details className="info">
        <summary>Your choices and rights</summary>
        <ul>
          <li>Taking part is <b>voluntary</b>. You can stop at any time without giving a reason.</li>
          <li>To <b>withdraw</b>, or to ask what I hold about you, email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> with the participant ID from the last screen. I’ll delete your recordings and details and leave them out of future training.</li>
          <li>A model trained before you withdrew can’t be “un-trained”, but it won’t be trained on your voice again.</li>
          <li>You must be <b>18 or older</b> to take part.</li>
          {ETHICS_REF && <li>Ethics clearance reference: {ETHICS_REF}.</li>}
        </ul>
      </details>

      <div className="checks">
        <label className="chk"><input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} /> <span>I’m 18 or older.</span></label>
        <label className="chk"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> <span>I’ve read this and I agree to my recordings and details being used for this project as described.</span></label>
      </div>
      <div className="row">
        <button className="btn primary big" disabled={!(adult && agree)} onClick={onAgree}>Agree and continue</button>
      </div>
    </section>
  );
}
