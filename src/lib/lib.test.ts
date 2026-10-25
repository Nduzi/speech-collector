import { describe, expect, it } from "vitest";
import { resample } from "./resample";
import { analyse } from "./quality";
import { UploadQueue, Job, JobStore } from "./queue";
import { Api, ApiError, RecordingRow, supabaseApi } from "./api";
import { encodeWav } from "./endpointer";

const sine = (f: number, sr: number, s: number, a = 0.5) => Float32Array.from({ length: Math.round(sr * s) }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / sr));
const rms = (x: Float32Array, a = 0, b = x.length) => Math.sqrt(x.slice(a, b).reduce((s, v) => s + v * v, 0) / (b - a));
/** Frequency by counting rising zero crossings. */
const freq = (x: Float32Array, sr: number) => { let c = 0; for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) c++; return (c * sr) / x.length; };

describe("resample", () => {
  it("48 kHz -> 16 kHz keeps length, frequency and level", () => {
    const y = resample(sine(1000, 48000, 1), 48000, 16000);
    expect(y.length).toBe(16000);
    expect(freq(y, 16000)).toBeCloseTo(1000, -1);
    expect(rms(y, 1000, 15000)).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });
  it("44.1 kHz -> 16 kHz works for non-integer ratios", () => {
    const y = resample(sine(500, 44100, 1), 44100, 16000);
    expect(Math.abs(y.length - 16000)).toBeLessThanOrEqual(1);
    expect(freq(y, 16000)).toBeCloseTo(500, -1);
  });
  it("removes content above the new Nyquist instead of aliasing it", () => {
    const y = resample(sine(12000, 48000, 1), 48000, 16000); // 12 kHz is above 8 kHz
    expect(rms(y, 1000, 15000)).toBeLessThan(0.02);
  });
  it("equal rates is a copy and the tail is not boosted", () => {
    const x = sine(300, 16000, 0.2);
    const y = resample(x, 16000, 16000);
    expect(y).not.toBe(x);
    expect(Array.from(y)).toEqual(Array.from(x));
    const z = resample(sine(300, 48000, 0.2), 48000, 16000);
    expect(Math.max(...Array.from(z).map(Math.abs))).toBeLessThan(0.6);
  });
});

describe("quality gate", () => {
  const noise = (n: number, a: number) => Float32Array.from({ length: n }, (_, i) => a * Math.sin(i * 12.9898) * Math.cos(i * 4.1414));
  const take = (peak: number, noiseAmp = 0.0005) => {
    const x = noise(16000, noiseAmp);
    const v = sine(220, 16000, 0.4, peak);
    x.set(v, 4000);
    return x;
  };
  it("accepts a normal take", () => {
    const q = analyse(take(0.3), 16000);
    expect(q.flag).toBe("ok");
    expect(q.blocking).toBe(false);
    expect(q.snrDb).toBeGreaterThan(20);
    expect(q.durationMs).toBe(1000);
  });
  it("blocks a take that is too quiet", () => {
    const q = analyse(take(0.01, 0.00005), 16000);
    expect(q.flag).toBe("too_quiet");
    expect(q.blocking).toBe(true);
  });
  it("blocks clipped audio", () => {
    const x = take(0.3);
    for (let i = 4000; i < 4800; i++) x[i] = i % 2 ? 1 : -1;
    expect(analyse(x, 16000).flag).toBe("clipped");
  });
  it("blocks very short and very long takes", () => {
    const short = analyse(sine(220, 16000, 0.1, 0.3), 16000);
    expect(short.blocking).toBe(true); // too short to hold a letter or number, whichever reason is reported first
    const x = take(0.3);
    const long = new Float32Array(16000 * 4);
    for (let i = 0; i < long.length; i++) long[i] = 0.0005 * Math.sin(i * 12.9898) * Math.cos(i * 4.1414);
    long.set(sine(220, 16000, 0.5, 0.3), 8000);
    expect(analyse(long, 16000).flag).toBe("too_long");
    void x;
  });
  it("flags noisy takes but does not block them", () => {
    const q = analyse(take(0.05, 0.02), 16000);
    expect(q.flag).toBe("noisy");
    expect(q.blocking).toBe(false);
  });
});

describe("WAV encoding", () => {
  it("writes a 16-bit mono PCM header of the right size", async () => {
    const b = encodeWav(sine(440, 16000, 0.5), 16000);
    expect(b.size).toBe(44 + 8000 * 2);
    const v = new DataView(await b.arrayBuffer());
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint16(34, true)).toBe(16);
  });
});

// ---------------------------------------------------------------------------------------------- upload queue
const row = (label: string): RecordingRow => ({ speaker_id: "s", label, round: 1, storage_path: `s/${label}_r1.wav`, sample_rate: 16000, native_sample_rate: 48000, duration_ms: 500, peak_dbfs: -6, rms_dbfs: -20, noise_floor_dbfs: -60, snr_db: 40, clipped_fraction: 0, quality_flag: "ok", retries: 0, device_label: "", endpoint_reason: "endpoint" });
const job = (label: string): Job => ({ key: `s/${label}_r1`, row: row(label), wav: new Blob(["x"]), attempts: 0 });
const memStore = (): JobStore & { m: Map<string, Job> } => { const m = new Map<string, Job>(); return { m, put: async (j) => { m.set(j.key, j); }, remove: async (k) => { m.delete(k); }, all: async () => [...m.values()] }; };
const fakeApi = (script: { upload?: (p: string, n: number) => void; insert?: (r: RecordingRow, n: number) => void } = {}) => {
  const log: string[] = [];
  const calls = { upload: 0, insert: 0 };
  const api: Api = {
    registerSpeaker: async () => undefined,
    uploadWav: async (p) => { const n = ++calls.upload; script.upload?.(p, n); log.push(`up ${p}`); },
    insertRecording: async (r) => { const n = ++calls.insert; script.insert?.(r, n); log.push(`row ${r.label}`); },
  };
  return { api, log, calls };
};
const fast = { baseDelayMs: 1, maxDelayMs: 2 };

describe("upload queue", () => {
  it("uploads in order, file before row, and clears the store", async () => {
    const f = fakeApi(); const st = memStore(); const q = new UploadQueue(f.api, st, fast);
    await q.add(job("A")); await q.add(job("B"));
    await q.drain();
    expect(f.log).toEqual(["up s/A_r1.wav", "row A", "up s/B_r1.wav", "row B"]);
    expect(st.m.size).toBe(0);
    expect(q.status().sent).toBe(2);
  });
  it("retries transient failures and then succeeds", async () => {
    const f = fakeApi({ upload: (_p, n) => { if (n <= 2) throw new ApiError(0, "offline", true); } });
    const q = new UploadQueue(f.api, memStore(), fast);
    await q.add(job("A")); await q.drain();
    expect(f.calls.upload).toBe(3);
    expect(q.status()).toMatchObject({ sent: 1, waiting: 0, failed: 0 });
  });
  it("retries the whole pair when the row insert fails (upload is idempotent)", async () => {
    // the 2nd attempt repeats upload (idempotent: server answers 409 -> success) and then inserts
    const f = fakeApi({ insert: (_r, n) => { if (n === 1) throw new ApiError(503, "busy", true); } });
    const q = new UploadQueue(f.api, memStore(), fast);
    await q.add(job("A")); await q.drain();
    expect(f.calls).toEqual({ upload: 2, insert: 2 });
    expect(q.status().sent).toBe(1);
  });
  it("gives up on permanent errors without hammering the server, and keeps the take", async () => {
    const f = fakeApi({ upload: () => { throw new ApiError(403, "forbidden", false); } });
    const st = memStore(); const q = new UploadQueue(f.api, st, fast);
    await q.add(job("A")); await q.add(job("B"));
    await new Promise((r) => setTimeout(r, 30));
    expect(f.calls.upload).toBe(2); // each tried once
    expect(q.status().failed).toBe(2);
    expect(st.m.size).toBe(2); // still stored for a manual retry
  });
  it("restores jobs from the store after a reload", async () => {
    const st = memStore(); await st.put(job("C"));
    const f = fakeApi(); const q = new UploadQueue(f.api, st, fast);
    await q.restore(); await q.drain();
    expect(f.log).toEqual(["up s/C_r1.wav", "row C"]);
  });
  it("discard removes a pending take", async () => {
    const f = fakeApi({ upload: () => { throw new ApiError(0, "offline", true); } });
    const st = memStore(); const q = new UploadQueue(f.api, st, { ...fast, baseDelayMs: 50, maxDelayMs: 50 });
    await q.add(job("A"));
    await q.discard("s/A_r1");
    expect(q.status().waiting).toBe(0);
    expect(st.m.size).toBe(0);
  });
});

describe("supabase api error mapping", () => {
  const withFetch = async (res: () => Response, f: () => Promise<void>) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => res()) as typeof fetch;
    try { await f(); } finally { globalThis.fetch = real; }
  };
  const wav = new Blob(["x"]);
  it("treats Storage's 400 'Duplicate' as already uploaded", () =>
    withFetch(() => new Response('{"statusCode":"409","error":"Duplicate","message":"The resource already exists","code":"KeyAlreadyExists"}', { status: 400 }), () => supabaseApi.uploadWav("a/b.wav", wav)));
  it("treats a plain 409 as already uploaded", () => withFetch(() => new Response("{}", { status: 409 }), () => supabaseApi.uploadWav("a/b.wav", wav)));
  it("keeps other 400s as permanent errors", async () => {
    await withFetch(() => new Response('{"error":"invalid_mime_type"}', { status: 400 }), async () => {
      await expect(supabaseApi.uploadWav("a/b.wav", wav)).rejects.toMatchObject({ status: 400, retryable: false });
    });
  });
  it("treats 5xx and network errors as retryable", async () => {
    await withFetch(() => new Response("oops", { status: 503 }), async () => {
      await expect(supabaseApi.uploadWav("a/b.wav", wav)).rejects.toMatchObject({ status: 503, retryable: true });
    });
    const real = globalThis.fetch;
    globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
    try { await expect(supabaseApi.insertRecording({} as RecordingRow)).rejects.toMatchObject({ status: 0, retryable: true }); } finally { globalThis.fetch = real; }
  });
  it("treats a duplicate recording row as saved", () => withFetch(() => new Response("{}", { status: 409 }), () => supabaseApi.insertRecording({} as RecordingRow)));
});

// ---------------------------------------------------------------------------------------------- "was a letter or number actually said?"
import { decideTake } from "./decision";

describe("speech check: taps, bumps and clicks are never accepted as recordings", () => {
  const SR = 16000;
  let seed = 11;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const room = (s: number) => Float32Array.from({ length: Math.round(SR * s) }, () => 0.0005 * rnd());
  const put = (x: Float32Array, y: Float32Array, atS: number) => { const o = Math.round(atS * SR); for (let i = 0; i < y.length && o + i < x.length; i++) x[o + i] += y[i]; return x; };
  /** A vowel-like sound: harmonics of f0 shaped by a slow rise and fall. */
  const vowel = (ms: number, f0 = 140, amp = 0.3) => { const n = Math.round((SR * ms) / 1000); return Float32Array.from({ length: n }, (_, i) => {
    const t = i / SR, env = Math.sin((Math.PI * i) / n) ** 0.7;
    return amp * env * [1, 0.7, 0.5, 0.35, 0.2].reduce((s, h, k) => s + h * Math.sin(2 * Math.PI * f0 * (k + 1) * t), 0) / 2.5;
  }); };
  /** A knock on a phone: a damped ring at a few hundred hertz. */
  const thump = (amp = 0.6, f = 180, tau = 0.012) => Float32Array.from({ length: Math.round(SR * 0.25) }, (_, i) => amp * Math.exp(-i / SR / tau) * Math.sin((2 * Math.PI * f * i) / SR));
  const click = () => { const y = new Float32Array(40); y[0] = 0.9; y[1] = -0.7; y[2] = 0.5; return y; };
  const hiss = (ms: number, amp = 0.2) => Float32Array.from({ length: Math.round((SR * ms) / 1000) }, () => amp * rnd());
  const take = (event: Float32Array, at = 0.35) => put(room(1.5), event, at);

  it("accepts a spoken vowel at normal, quiet and brief lengths", () => {
    for (const [ms, amp] of [[450, 0.3], [250, 0.3], [150, 0.3], [450, 0.04]] as const) {
      const q = analyse(take(vowel(ms, 140, amp)), SR);
      expect(q.speechless, `${ms} ms at ${amp}`).toBe(false);
      expect(q.voicedMs).toBeGreaterThanOrEqual(100);
    }
  });
  it("accepts women's and children's higher voices", () => {
    for (const f0 of [220, 300, 380]) expect(analyse(take(vowel(400, f0)), SR).speechless, `f0 ${f0}`).toBe(false);
  });
  it("rejects a screen tap or bump (a damped thump), loud or soft", () => {
    for (const [amp, f, tau] of [[0.6, 180, 0.012], [0.9, 120, 0.02], [0.2, 250, 0.01], [0.8, 160, 0.03], [0.8, 160, 0.05], [1, 90, 0.04]] as const) {
      const q = analyse(take(thump(amp, f, tau)), SR);
      expect(q.speechless, `thump ${amp}/${f}/${tau}`).toBe(true);
      expect(q.flag).toBe("no_speech");
      expect(q.blocking).toBe(true);
    }
  });
  it("rejects a click, a breath or hiss, and silence", () => {
    expect(analyse(take(click()), SR).speechless).toBe(true);
    expect(analyse(take(hiss(400)), SR).speechless).toBe(true);
    expect(analyse(room(1.5), SR).speechless).toBe(true);
  });
  it("rejects a tap even when it is followed by a long quiet tail of room sound", () => {
    expect(analyse(put(take(thump()), hiss(500, 0.01), 0.5), SR).speechless).toBe(true);
  });
  it("a speechless take is never accepted, however many times it is tried", () => {
    const q = analyse(take(thump()), SR);
    for (const tries of [0, 3, 10, 50]) {
      for (const reason of ["endpoint", "manual", "max_duration"]) {
        const d = decideTake(q, { tries, maxRetries: 3, uiDuringCapture: false, reason });
        expect(d.action, `tries ${tries} ${reason}`).toBe("retry");
      }
    }
  });
  it("a bump while the screen was being touched is ignored quietly, but a manual take always gets feedback", () => {
    const q = analyse(take(thump()), SR);
    expect(decideTake(q, { tries: 0, maxRetries: 3, uiDuringCapture: true, reason: "endpoint" }).action).toBe("ignore");
    expect(decideTake(q, { tries: 0, maxRetries: 3, uiDuringCapture: true, reason: "manual" }).action).toBe("retry");
  });
  it("real speech is accepted even when the screen was touched, and quiet speech is kept after retries", () => {
    expect(decideTake(analyse(take(vowel(400)), SR), { tries: 0, maxRetries: 3, uiDuringCapture: true, reason: "endpoint" }).action).toBe("accept");
    const quiet = analyse(take(vowel(400, 140, 0.004)), SR);
    expect(quiet.flag).toBe("too_quiet");
    expect(decideTake(quiet, { tries: 0, maxRetries: 3, uiDuringCapture: false, reason: "endpoint" }).action).toBe("retry");
    expect(decideTake(quiet, { tries: 3, maxRetries: 3, uiDuringCapture: false, reason: "endpoint" }).action).toBe("accept"); // still a spoken letter, so it is kept (flagged)
  });
});

// ---------------------------------------------------------------------------------------------- the chess piece prompts
import { PROMPTS } from "../config";
import { Session, firstOpenRound, missingPieces, roundOrder, takeKey } from "./session";

describe("chess piece prompts", () => {
  const base = (done: Record<string, 1>): Session => ({ v: 1, speakerId: "aaaaaaaa-1111-4111-8111-000000000001", name: "A", createdAt: 0, targetRounds: 5, round: 5, done, retries: {}, finished: true });
  it("are part of every round, with database-safe labels", () => {
    expect(PROMPTS.filter((p) => p.kind === "piece").map((p) => p.label)).toEqual(["King", "Queen", "Rook", "Bishop", "Knight", "Pawn"]);
    expect(PROMPTS.length).toBe(22);
    expect(new Set(PROMPTS.map((p) => p.label)).size).toBe(22);
    for (const p of PROMPTS) expect(p.label).toMatch(/^[A-Za-z0-9]{1,20}$/); // the database and storage rules
    for (const r of [1, 2, 3]) expect(roundOrder("aaaaaaaa-1111-4111-8111-000000000001", r).map((p) => p.label).sort()).toEqual(PROMPTS.map((p) => p.label).sort());
  });
  it("people who finished the original 16 are asked only for the pieces, starting at the first round that lacks them", () => {
    const old: Record<string, 1> = {};
    for (let r = 1; r <= 5; r++) for (const p of PROMPTS) if (p.kind !== "piece") old[takeKey("aaaaaaaa-1111-4111-8111-000000000001", p.label, r)] = 1;
    const s = base(old);
    expect(missingPieces(s)).toBe(30);
    expect(firstOpenRound(s)).toBe(1);
    const partway = { ...old };
    for (const p of PROMPTS) if (p.kind === "piece") for (const r of [1, 2]) partway[takeKey(s.speakerId, p.label, r)] = 1;
    expect(missingPieces(base(partway))).toBe(18);
    expect(firstOpenRound(base(partway))).toBe(3);
  });
  it("someone who has everything is not asked again", () => {
    const all: Record<string, 1> = {};
    for (let r = 1; r <= 5; r++) for (const p of PROMPTS) all[takeKey("aaaaaaaa-1111-4111-8111-000000000001", p.label, r)] = 1;
    expect(missingPieces(base(all))).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------- "finish what is missing" links
import { decodeMissing, encodeMissing, parseResumeLink, sessionFromLink } from "./resume";

describe("resume links", () => {
  const ID = "2240e01a-94db-4488-a10e-689b0cc1f48e";
  const idx = (label: string) => PROMPTS.findIndex((p) => p.label === label);
  const pieces = PROMPTS.map((p, i) => [p, i] as const).filter(([p]) => p.kind === "piece").map(([, i]) => i);
  const link = (missing: Array<[number, number]>, extra = "") => `?add=${ID}&n=Nay&r=5&p=${PROMPTS.length}&m=${encodeMissing(missing)}${extra}`;

  it("round-trips any set of missing recordings", () => {
    const m: Array<[number, number]> = [[1, 0], [1, 21], [3, 7], [5, 21], [5, 16]];
    expect(decodeMissing(encodeMissing(m)).sort()).toEqual([...m].sort());
    expect(decodeMissing(encodeMissing([]))).toEqual([]);
  });
  it("the ask for every chess piece in 5 rounds fits in a short link", () => {
    const all: Array<[number, number]> = [];
    for (let r = 1; r <= 5; r++) for (const i of pieces) all.push([r, i]);
    expect(encodeMissing(all).length).toBeLessThanOrEqual(24);
  });
  it("builds a session where only the missing recordings are still to do", () => {
    const missing: Array<[number, number]> = [];
    for (let r = 1; r <= 5; r++) for (const i of pieces) missing.push([r, i]);
    const l = parseResumeLink(link(missing))!;
    expect(l).not.toBeNull();
    const s = sessionFromLink(l, 1000);
    expect(s.speakerId).toBe(ID);
    expect(s.name).toBe("Nay");
    expect(s.finished).toBe(false);
    expect(s.round).toBe(1);
    expect(Object.keys(s.done).length).toBe(5 * 16);
    expect(missingPieces(s)).toBe(30);
    expect(s.done[takeKey(ID, "A", 1)]).toBe(1);
    expect(s.done[takeKey(ID, "King", 1)]).toBeUndefined();
    expect(s.createdAt).toBe(1000);
  });
  it("starts at the first round that has something missing, and a link with nothing missing means finished", () => {
    const l = parseResumeLink(link([[3, idx("Pawn")], [4, idx("A")]]))!;
    expect(sessionFromLink(l).round).toBe(3);
    expect(sessionFromLink(l).finished).toBe(false);
    expect(sessionFromLink(parseResumeLink(link([]))!).finished).toBe(true);
  });
  it("asks for individual missing letters, not only chess pieces", () => {
    const s = sessionFromLink(parseResumeLink(link([[2, idx("E")], [2, idx("Five")]]))!);
    expect(s.done[takeKey(ID, "E", 2)]).toBeUndefined();
    expect(s.done[takeKey(ID, "E", 1)]).toBe(1);
    expect(Object.keys(s.done).length).toBe(5 * 22 - 2);
  });
  it("rejects malformed or stale links instead of guessing", () => {
    expect(parseResumeLink("")).toBeNull();
    expect(parseResumeLink(link([[1, 0]]).replace(ID, "not-a-uuid"))).toBeNull();
    expect(parseResumeLink(link([[1, 0]]).replace("&r=5", "&r=11"))).toBeNull();
    expect(parseResumeLink(link([[1, 0]]).replace("&r=5", "&r=0"))).toBeNull();
    expect(parseResumeLink(link([[1, 0]]).replace(`&p=${PROMPTS.length}`, "&p=16"))).toBeNull(); // made for a different list of words
    expect(parseResumeLink(link([[1, 0]]).replace(/&m=[^&]*/, "&m=zz%20zz"))).toBeNull();
    expect(parseResumeLink(link([[6, 0]]))).toBeNull(); // a round beyond the stated rounds
    expect(parseResumeLink(link([[1, 0]], "&n=" + "x".repeat(200)))?.name.length).toBeLessThanOrEqual(60);
  });
});

// ---------------------------------------------------------------------------------------------- carrying on with a participant ID
import { sessionFromProgress } from "./resume";
import { fetchProgress } from "./api";

describe("carry on with a participant ID", () => {
  const ID = "2240e01a-94db-4488-a10e-689b0cc1f48e";
  const rec = (labels: string[], rounds: number[]) => labels.flatMap((l) => rounds.map((r) => [l, r] as [string, number]));
  it("marks what the database holds as done and asks only for the rest", () => {
    const s = sessionFromProgress(ID, { name: "Nay", recorded: rec(PROMPTS.filter((p) => p.kind !== "piece").map((p) => p.label), [1, 2, 3, 4, 5]) });
    expect(s.name).toBe("Nay");
    expect(s.targetRounds).toBe(5);
    expect(s.finished).toBe(false);
    expect(s.round).toBe(1);
    expect(Object.keys(s.done).length).toBe(80);
    expect(missingPieces(s)).toBe(30);
  });
  it("someone with everything recorded goes straight to the thank-you page", () => {
    const s = sessionFromProgress(ID, { name: "Ada", recorded: rec(PROMPTS.map((p) => p.label), [1, 2, 3, 4, 5]) });
    expect(s.finished).toBe(true);
    expect(missingPieces(s)).toBe(0);
  });
  it("keeps going past five rounds if the person recorded more, and ignores words it does not know", () => {
    const s = sessionFromProgress(ID, { name: "Z", recorded: [...rec(PROMPTS.map((p) => p.label), [1, 2, 3, 4, 5, 6, 7]), ["Banana", 1], ["A", 99], ["A", 0]] });
    expect(s.targetRounds).toBe(7);
    expect(s.finished).toBe(true);
    expect(Object.keys(s.done).length).toBe(22 * 7);
  });
  it("starts at the first round that is missing something", () => {
    const rounds12 = rec(PROMPTS.map((p) => p.label), [1, 2]);
    const s = sessionFromProgress(ID, { name: "Z", recorded: [...rounds12, ...rec(PROMPTS.map((p) => p.label).filter((l) => l !== "Pawn"), [3])] });
    expect(s.round).toBe(3);
  });
  it("looks the ID up through the database function and passes the answer through", async () => {
    const real = globalThis.fetch;
    let seen: { url: string; body: string } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => { seen = { url, body: String(init.body) }; return new Response(JSON.stringify({ name: "Nay", window_open: true, recorded: [["A", 1]] }), { status: 200 }); }) as typeof fetch;
    try {
      const p = await fetchProgress(ID);
      expect(p).toEqual({ name: "Nay", window_open: true, recorded: [["A", 1]] });
      expect(seen!.url).toMatch(/\/rest\/v1\/rpc\/my_progress$/);
      expect(JSON.parse(seen!.body)).toEqual({ p: ID });
      globalThis.fetch = (async () => new Response("null", { status: 200 })) as typeof fetch;
      expect(await fetchProgress(ID)).toBeNull();
      globalThis.fetch = (async () => new Response("oops", { status: 503 })) as typeof fetch;
      await expect(fetchProgress(ID)).rejects.toMatchObject({ retryable: true });
    } finally { globalThis.fetch = real; }
  });
});
