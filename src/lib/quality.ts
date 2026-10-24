/** Objective checks on one take, done on the 16 kHz signal that will actually be uploaded. */
export interface Quality {
  durationMs: number;
  peakDbfs: number;
  rmsDbfs: number; // of the speech part
  noiseFloorDbfs: number; // of the quietest tenth of the take
  snrDb: number;
  clippedFraction: number;
  voicedMs: number; // total time with a vowel-like (periodic) sound clearly above the background
  longestVoicedMs: number; // the longest unbroken stretch of it
  sustainedMs: number; // how long the best stretch holds within 4 dB of its own peak (speech holds its level; a thump decays)
  speechless: boolean; // no vowel at all: a tap, bump, click, breath or silence, never a spoken letter or number
  flag: "ok" | "too_quiet" | "clipped" | "too_short" | "too_long" | "noisy" | "no_speech";
  message: string; // shown to the speaker when it is not "ok"
  blocking: boolean; // a take that cannot be useful: ask for a retry first
}

const db = (x: number) => 10 * Math.log10(x + 1e-12);

export const NO_SPEECH_MESSAGE = "That didn’t sound like a letter or number. It may have been a tap or a bump. Wait until it says “Listening”, then say it out loud.";
// Every one of the 16 prompts (A–H, one–eight) contains a voiced vowel. Chosen against 166 real recordings from three people (shortest voiced total 160 ms for clean takes)
// and against synthetic knocks, whose ring-down never held its level for 50 ms.
const MIN_VOICED_MS = 100;
const MIN_RUN_MS = 50;
const MIN_SUSTAINED_MS = 50;
const LONG_RUN_MS = 200;

/** Time with vowel-like sound: frames (25 ms, every 10 ms) that are above the take's own background (by 6 dB) AND within 25 dB of its loudest
 *  frame AND periodic at a speaking pitch (80–400 Hz). A tap or thump rings for only a few frames, a click or breath is not periodic. */
export function voicing(x: Float32Array, sr: number, floorDb: number): { voicedMs: number; longestMs: number; sustainedMs: number } {
  const win = Math.round(sr * 0.025);
  const hop = Math.round(sr * 0.01);
  const lagMin = Math.floor(sr / 400);
  const lagMax = Math.min(Math.ceil(sr / 80), Math.floor(win * 0.6));
  const energy: number[] = [];
  const starts: number[] = [];
  for (let s = 0; s + win <= x.length; s += hop) {
    let e = 0;
    for (let k = s; k < s + win; k++) e += x[k] * x[k];
    energy.push(db(e / win));
    starts.push(s);
  }
  if (!energy.length) return { voicedMs: 0, longestMs: 0, sustainedMs: 0 };
  const top = Math.max(...energy);
  const gate = Math.max(floorDb + 6, top - 25, -62);
  let voiced = 0;
  let run = 0;
  let longest = 0;
  let sustained = 0; // frames of the best run that stay within 4 dB of that run's peak: speech holds its level, a thump falls away
  let runDb: number[] = [];
  for (let i = 0; i < energy.length; i++) {
    let isVoiced = false;
    if (energy[i] > gate) {
      const s = starts[i];
      let mean = 0;
      for (let k = 0; k < win; k++) mean += x[s + k];
      mean /= win;
      let best = 0;
      for (let lag = lagMin; lag <= lagMax; lag++) {
        let r = 0, a = 0, b = 0;
        for (let k = 0; k + lag < win; k++) {
          const u = x[s + k] - mean, v = x[s + k + lag] - mean;
          r += u * v; a += u * u; b += v * v;
        }
        const c = r / (Math.sqrt(a * b) + 1e-12);
        if (c > best) best = c;
      }
      isVoiced = best > 0.45;
    }
    if (isVoiced) { voiced++; run++; longest = Math.max(longest, run); runDb.push(energy[i]); } else { run = 0; runDb = []; }
    if (runDb.length) { const pk = Math.max(...runDb); sustained = Math.max(sustained, runDb.filter((e) => e >= pk - 4).length); }
  }
  return { voicedMs: voiced * 10, longestMs: longest * 10, sustainedMs: sustained * 10 };
}

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
  const v = voicing(x, sr, noise);
  const out: Quality = {
    durationMs: Math.round((n / sr) * 1000),
    peakDbfs: round1(db(peak * peak)),
    rmsDbfs: round1(speech),
    noiseFloorDbfs: round1(noise),
    snrDb: round1(speech - noise),
    clippedFraction: n ? clipped / n : 0,
    voicedMs: v.voicedMs,
    longestVoicedMs: v.longestMs,
    sustainedMs: v.sustainedMs,
    // a stretch of vowel-like sound longer than any knock rings for needs no steadiness test (speech with a gliding or pumping level, e.g. a phone's auto-gain)
    speechless: v.voicedMs < MIN_VOICED_MS || v.longestMs < MIN_RUN_MS || (v.sustainedMs < MIN_SUSTAINED_MS && v.longestMs < LONG_RUN_MS),
    flag: "ok",
    message: "",
    blocking: false,
  };
  const set = (flag: Quality["flag"], message: string, blocking: boolean) => {
    if (out.flag === "ok") Object.assign(out, { flag, message, blocking });
  };
  if (out.speechless) set("no_speech", NO_SPEECH_MESSAGE, true); // first, so nothing else can wave a speechless take through
  if (out.durationMs < 150) set("too_short", "That was too short. Wait until it says “Listening”, then say it clearly.", true);
  else if (out.durationMs > 3500) set("too_long", "That ran too long. Say only the letter or number, then stop.", true);
  if (out.peakDbfs < -32) set("too_quiet", "That was too quiet. Move a little closer to the microphone, or speak up.", true);
  if (out.clippedFraction > 0.01) set("clipped", "That was too loud and distorted. Move back a little, or speak more softly.", true);
  if (out.snrDb < 12) set("noisy", "There’s a lot of background noise. A quieter spot would help, but you can keep going.", false);
  return out;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
