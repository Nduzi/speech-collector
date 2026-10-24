import { describe, expect, it } from "vitest";
import { resample } from "./resample";
import { analyse } from "./quality";
import { UploadQueue, Job, JobStore } from "./queue";
import { Api, ApiError, RecordingRow } from "./api";
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
    expect(analyse(sine(220, 16000, 0.1, 0.3), 16000).flag).toBe("too_short");
    expect(analyse(sine(220, 16000, 4, 0.3), 16000).flag).toBe("too_long");
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
