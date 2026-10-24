import { FormEvent, useState } from "react";
import { DEFAULT_ROUNDS } from "../config";
import { SpeakerInput, supabaseApi } from "../lib/api";
import { Session, newSpeakerId } from "../lib/session";

const AGE = [["18-24", "18–24"], ["25-34", "25–34"], ["35-44", "35–44"], ["45-54", "45–54"], ["55-64", "55–64"], ["65+", "65 or older"], ["prefer_not", "Prefer not to say"]];
const GENDER = [["female", "Female"], ["male", "Male"], ["non_binary", "Non-binary"], ["self_describe", "Another description"], ["prefer_not", "Prefer not to say"]];
const LANGS = ["English", "Afrikaans", "isiZulu", "isiXhosa", "Sepedi", "Setswana", "Sesotho", "Xitsonga", "siSwati", "Tshivenda", "isiNdebele"];
const MIC = [["phone_builtin", "Phone (built-in microphone)"], ["laptop_builtin", "Laptop (built-in microphone)"], ["wired_headset", "Wired headset or earphones"], ["bluetooth_headset", "Bluetooth headset or earbuds"], ["usb_mic", "External or USB microphone"], ["other", "Something else"]];
const ENV = [["quiet_room", "A quiet room"], ["normal_room", "A normal room with some background sound"], ["noisy", "Somewhere noisy, like a street, café or open office"]];
const PROVINCES = ["Eastern Cape", "Free State", "Gauteng", "KwaZulu-Natal", "Limpopo", "Mpumalanga", "North West", "Northern Cape", "Western Cape"];

const campaign = () => (new URLSearchParams(location.search).get("c") ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);

export function About({ onBack, onRegistered }: { onBack: () => void; onRegistered: (s: Session) => void }) {
  const [f, setF] = useState({ name: "", age: "", gender: "", lang: "", langOther: "", accent: "", country: "South Africa", region: "", mic: "", env: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const lang = f.lang === "__other" ? f.langOther.trim() : f.lang;
  const valid = f.name.trim().length > 0 && f.age && f.gender && lang && f.country.trim() && f.mic && f.env;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setErr("");
    const id = newSpeakerId();
    const body: SpeakerInput = {
      display_name: f.name.trim().slice(0, 60), age_band: f.age, gender: f.gender, first_language: lang.slice(0, 60),
      accent_note: f.accent.trim().slice(0, 120), country: f.country.trim().slice(0, 60), region: f.region.trim().slice(0, 60),
      mic_type: f.mic, environment: f.env, campaign: campaign(),
    };
    try {
      await supabaseApi.registerSpeaker(id, body);
      onRegistered({ v: 1, speakerId: id, name: body.display_name, createdAt: Date.now(), targetRounds: DEFAULT_ROUNDS, round: 1, done: {}, retries: {}, finished: false });
    } catch (ex: any) {
      setErr(ex?.status === 0 ? "Couldn’t reach the server. Check your internet connection and try again." : "Your details didn’t save. Please try again in a moment.");
      setBusy(false);
    }
  }

  return (
    <form className="sheet pad" onSubmit={submit} noValidate>
      <h1>About you</h1>
      <p className="lead">These answers help me check that the system works fairly for different voices. Only I see them.</p>

      <div className="fields">
        <label className="f"><span>First name or nickname</span>
          <input type="text" value={f.name} onChange={set("name")} maxLength={60} autoComplete="given-name" required />
          <span className="hint">Not your surname.</span></label>

        <div className="two">
          <label className="f"><span>Age</span>
            <select value={f.age} onChange={set("age")} required><option value="">Choose one</option>{AGE.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
          <label className="f"><span>Gender</span>
            <select value={f.gender} onChange={set("gender")} required><option value="">Choose one</option>{GENDER.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
        </div>

        <label className="f"><span>Home language</span>
          <select value={f.lang} onChange={set("lang")} required><option value="">Choose one</option>{LANGS.map((l) => <option key={l}>{l}</option>)}<option value="__other">Another language…</option></select><span className="hint">The one you grew up speaking most.</span></label>
        {f.lang === "__other" && <label className="f"><span>Which language?</span><input type="text" value={f.langOther} onChange={set("langOther")} maxLength={60} required /></label>}

        <label className="f"><span>Accent, or where you grew up <i>(optional)</i></span>
          <input type="text" value={f.accent} onChange={set("accent")} maxLength={120} placeholder="e.g. Soweto, Durban English, Cape Flats" /></label>

        <div className="two">
          <label className="f"><span>Country</span><input type="text" value={f.country} onChange={set("country")} maxLength={60} required /></label>
          <label className="f"><span>Province or region <i>(optional)</i></span><input type="text" list="provinces" value={f.region} onChange={set("region")} maxLength={60} /><datalist id="provinces">{PROVINCES.map((p) => <option key={p} value={p} />)}</datalist></label>
        </div>

        <label className="f"><span>What are you recording with?</span>
          <select value={f.mic} onChange={set("mic")} required><option value="">Choose one</option>{MIC.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
        <label className="f"><span>Where are you recording?</span>
          <select value={f.env} onChange={set("env")} required><option value="">Choose one</option>{ENV.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
      </div>

      {err && <div className="note bad" role="alert">{err}</div>}
      <div className="row">
        <button type="submit" className="btn primary big" disabled={!valid || busy}>{busy ? "Saving…" : "Continue"}</button>
        <button type="button" className="btn ghost" onClick={onBack} disabled={busy}>Back</button>
      </div>
    </form>
  );
}
