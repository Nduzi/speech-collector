/** Objective checks on one take, done on the 16 kHz signal that will actually be uploaded. */
export interface Quality {
  durationMs: number;
  peakDbfs: number;
  rmsDbfs: number; // of the speech part
  noiseFloorDbfs: number; // of the quietest tenth of the take
  snrDb: number;
  clippedFraction: number;
  flag: "ok" | "too_quiet" | "clipped" | "too_short" | "too_long" | "noisy";
  message: string; // shown to the speaker when it is not "ok"
  blocking: boolean; // a take that cannot be useful: ask for a retry first
}

const db = (x: number) => 10 * Math.log10(x + 1e-12);

export function analyse(x: Float32Array, sr: number): Quality {
  const n = x.length;
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
    if (a >= 0.985) clipped++;
  }
  // frame energies (20 ms) -> noise floor from the quietest 10 %, speech level from the loudest 30 %
  const hop = Math.max(1, Math.round(sr * 0.02));
  const e: number[] = [];
  for (let s = 0; s + hop <= n; s += hop) {
    let a = 0;
    for (let k = s; k < s + hop; k++) a += x[k] * x[k];
    e.push(a / hop);
  }
  const sorted = [...e].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const noise = db(q(0.1));
  const loud = sorted.slice(Math.floor(sorted.length * 0.7));
  const speech = db(loud.length ? loud.reduce((s, v) => s + v, 0) / loud.length : 0);
  const out: Quality = {
    durationMs: Math.round((n / sr) * 1000),
    peakDbfs: round1(db(peak * peak)),
    rmsDbfs: round1(speech),
    noiseFloorDbfs: round1(noise),
    snrDb: round1(speech - noise),
    clippedFraction: n ? clipped / n : 0,
    flag: "ok",
    message: "",
    blocking: false,
  };
  const set = (flag: Quality["flag"], message: string, blocking: boolean) => {
    if (out.flag === "ok") Object.assign(out, { flag, message, blocking });
  };
  if (out.durationMs < 150) set("too_short", "That was too short. Wait until it says “Listening”, then say it clearly.", true);
  else if (out.durationMs > 3500) set("too_long", "That ran too long. Say only the letter or number, then stop.", true);
  if (out.peakDbfs < -32) set("too_quiet", "That was too quiet. Move a little closer to the microphone, or speak up.", true);
  if (out.clippedFraction > 0.01) set("clipped", "That was too loud and distorted. Move back a little, or speak more softly.", true);
  if (out.snrDb < 12) set("noisy", "There’s a lot of background noise. A quieter spot would help, but you can keep going.", false);
  return out;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
