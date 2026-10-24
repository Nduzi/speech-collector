import { useState } from "react";
import { CONTACT_EMAIL, DEFAULT_ROUNDS, ETHICS_REF, INSTITUTION, PROJECT_TITLE, PROMPTS, RESEARCHER } from "../config";

export function Consent({ onAgree }: { onAgree: () => void }) {
  const [adult, setAdult] = useState(false);
  const [agree, setAgree] = useState(false);
  const minutes = Math.round((DEFAULT_ROUNDS * PROMPTS.length * 4.5) / 60);
  return (
    <section className="sheet pad">
      <p className="eyebrow">Final-year project · {INSTITUTION}</p>
      <h1>Help a chess board learn to listen</h1>
      <p className="lead">
        We are building <b>{PROJECT_TITLE}</b>: you say a move out loud, such as “E two … E four”, and the board moves the piece for you.
        This is the final-year project of <b>{RESEARCHER}</b> at the <b>{INSTITUTION}</b>, and he would really appreciate your contribution.
      </p>
      <p>
        Chess squares are named with the letters <b>A to H</b> and the numbers <b>1 to 8</b>, so the board has to recognise exactly those {PROMPTS.length} words, spoken by many different people, accents and microphones. That is where you come in: a few minutes of your voice makes the system work for more people.
      </p>

      <ol className="steps">
        <li><b>Tell us a little about you</b> — first name or nickname, and a few details that affect how voices sound.</li>
        <li><b>Check your microphone</b> — your phone or laptop is fine.</li>
        <li><b>Say each word</b> as it appears — {PROMPTS.length} different words, {DEFAULT_ROUNDS} times each. About <b>{minutes} minutes</b> in a quiet spot. You can stop and carry on later.</li>
      </ol>

      <details className="info" open>
        <summary>What we collect, and what happens to it</summary>
        <ul>
          <li><b>Your voice recordings</b> of the words above, and the technical details of each (length, loudness, microphone name).</li>
          <li><b>About you:</b> a first name or nickname (not your surname), age range, gender, home language, accent or region, country, the kind of microphone and room you used. Age and gender have a “prefer not to say” option.</li>
          <li><b>We do not collect</b> your surname, email address, phone number, ID number or location. The services that host this page and the data may keep ordinary technical logs, such as an IP address.</li>
          <li><b>Who sees it:</b> only the project team. The recordings are used to train and test speech recognition models. They are not published, sold, or shared outside the team.</li>
          <li><b>Where it is stored:</b> a secured cloud database (Supabase) hosted in Ireland. Access is limited to the project team.</li>
          <li><b>How long:</b> only as long as the project needs it, after which it is deleted.</li>
        </ul>
      </details>

      <details className="info">
        <summary>Your choices and rights</summary>
        <ul>
          <li>Taking part is <b>voluntary</b>. You can stop at any time, and you do not have to give a reason.</li>
          <li>To <b>withdraw</b> or to ask what we hold about you, email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> with the participant ID shown on the final screen. We will delete your recordings and details and leave them out of future training.</li>
          <li>A model that was already trained before you withdrew cannot be “un-trained”, but it will not be trained on your voice again.</li>
          <li>You must be <b>18 or older</b> to take part.</li>
          {ETHICS_REF && <li>Ethics clearance reference: {ETHICS_REF}.</li>}
        </ul>
      </details>

      <div className="checks">
        <label className="chk"><input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} /> <span>I am 18 years or older.</span></label>
        <label className="chk"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> <span>I have read the information above and I agree to my voice recordings and the details I give being used for this project in this way.</span></label>
      </div>
      <div className="row">
        <button className="btn primary big" disabled={!(adult && agree)} onClick={onAgree}>I agree — continue</button>
      </div>
    </section>
  );
}
