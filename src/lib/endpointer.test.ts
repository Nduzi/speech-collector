import { describe, expect, it } from "vitest";
import { DEFAULT_ENDPOINT, Endpointer, EndReason } from "./endpointer";

const SR = 48000; // deliberately not 16 kHz: the browser's real rate must be handled

function noise(n: number, amp: number, seed = 1) {
  let s = seed;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 2 ** 32) * 2 - 1) * amp;
  }
  return out;
}
const tone = (ms: number, f: number, amp: number) => {
  const n = Math.round((SR * ms) / 1000);
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = amp * Math.sin((2 * Math.PI * f * i) / SR);
  return o;
};
/** high-passed noise: a stand-in for a weak /s/ */
function fric(ms: number, amp: number) {
  const x = noise(Math.round((SR * ms) / 1000), 1, 7);
  const o = new Float32Array(x.length);
  for (let i = 1; i < x.length; i++) o[i] = (x[i] - x[i - 1]) * amp * 0.5;
  return o;
}
const cat = (...a: Float32Array[]) => {
  const o = new Float32Array(a.reduce((s, x) => s + x.length, 0));
  let p = 0;
  for (const x of a) (o.set(x, p), (p += x.length));
  return o;
};
const add = (a: Float32Array, b: Float32Array) => a.map((v, i) => v + b[i]);

function run(sig: Float32Array, cfg = {}, chunk = 1000) {
  const events: { samples: Float32Array; reason: EndReason; speechMs: number }[] = [];
  let timeout = false;
  const ep = new Endpointer(SR, cfg, { onUtterance: (u) => events.push(u), onNoSpeech: () => (timeout = true) });
  ep.listen();
  for (let i = 0; i < sig.length; i += chunk) ep.push(sig.subarray(i, i + chunk));
  return { events, timeout, ep };
}

describe("Endpointer", () => {
  const bg = (ms: number) => noise(Math.round((SR * ms) / 1000), 0.002, 3);

  it("detects a vowel, includes pre-roll and hangover, and ends by endpoint", () => {
    const speech = add(tone(400, 220, 0.2), noise(Math.round(SR * 0.4), 0.002));
    const sig = cat(bg(800), speech, bg(1500));
    const { events } = run(sig);
    expect(events).toHaveLength(1);
    const u = events[0];
    expect(u.reason).toBe("endpoint");
    const ms = (u.samples.length / SR) * 1000;
    // pre-roll(<=300) + 400ms speech + hangover(~550)
    expect(ms).toBeGreaterThan(400 + 250 + 400);
    expect(ms).toBeLessThan(400 + 300 + 700);
  });

  it("catches a weak /s/ via the high band when low-frequency room noise masks the full-band level", () => {
    // Background: LF rumble (dominates full-band energy) + faint hiss. A weak /s/ barely moves the
    // full-band level (< onset threshold) but lifts the high band by ~20 dB.
    const rumble = (ms: number) => add(tone(ms, 100, 0.01), noise(Math.round((SR * ms) / 1000), 0.0005, 3));
    const weak = add(fric(150, 0.01), rumble(150));
    const vowel = add(tone(300, 300, 0.25), rumble(300));
    const sig = cat(rumble(800), weak, vowel, rumble(1500));
    const capturedMs = (cfg: object) => {
      const { events } = run(sig, { preRollMs: 0, ...cfg });
      expect(events).toHaveLength(1);
      return (events[0].samples.length / SR) * 1000;
    };
    const withHf = capturedMs({});
    const withoutHf = capturedMs({ hfOnsetDb: 999, minHfLevelDb: 999 });
    // With the high-band trigger the capture starts at the /s/ (+150 ms vs. starting at the vowel).
    expect(withHf - withoutHf).toBeGreaterThan(110);
    expect(withHf - withoutHf).toBeLessThan(200);
  });

  it("pre-roll preserves audio that precedes the trigger", () => {
    const sig = cat(bg(800), tone(300, 300, 0.25), bg(1500));
    const ms = (cfg: object) => (run(sig, cfg).events[0].samples.length / SR) * 1000;
    expect(ms({ preRollMs: 300 }) - ms({ preRollMs: 0 })).toBeGreaterThan(200);
  });

  it("ends the utterance even when room noise fluctuates a few dB (real rooms are not stationary)", () => {
    // Background level wanders by -4..+6 dB every ~40 ms: above the old "quiet" line (floor+4 dB) but far below speech.
    const wander = (ms: number, seed: number) => {
      const out = new Float32Array(Math.round((SR * ms) / 1000));
      let s = seed;
      const seg = Math.round(SR * 0.04);
      for (let i = 0; i < out.length; i += seg) {
        s = (s * 1664525 + 1013904223) >>> 0;
        const amp = 0.002 * 10 ** ((-4 + 10 * (s / 2 ** 32)) / 20);
        const n = noise(Math.min(seg, out.length - i), amp, s);
        out.set(n, i);
      }
      return out;
    };
    const sig = cat(wander(800, 11), add(tone(400, 220, 0.2), wander(400, 5)), wander(3000, 77));
    const { events } = run(sig);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("endpoint");
    expect((events[0].samples.length / SR) * 1000).toBeLessThan(400 + 300 + 900);
  });

  it("times out with no speech", () => {
    const { events, timeout } = run(bg(9000));
    expect(events).toHaveLength(0);
    expect(timeout).toBe(true);
  });

  it("ignores a single short click", () => {
    const click = new Float32Array(Math.round(SR * 0.012)).fill(0.5);
    const sig = cat(bg(800), click, bg(2000));
    const { events } = run(sig, { noSpeechTimeoutMs: 0 });
    expect(events).toHaveLength(0);
  });

  it("forces an end at the maximum duration", () => {
    const sig = cat(bg(600), tone(6000, 200, 0.2));
    const { events } = run(sig, { maxDurationMs: 2000 });
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("max_duration");
    expect((events[0].samples.length / SR) * 1000).toBeLessThanOrEqual(2050);
  });

  it("supports manual start/stop independent of the detector", () => {
    const events: any[] = [];
    const ep = new Endpointer(SR, {}, { onUtterance: (u) => events.push(u) });
    ep.listen();
    ep.push(bg(500));
    ep.forceStart();
    ep.push(bg(700));
    ep.forceStop();
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("manual");
  });

  it("is insensitive to chunk size", () => {
    const sig = cat(bg(800), add(tone(400, 220, 0.2), bg(400)), bg(1500));
    const a = run(sig, {}, 128).events[0];
    const b = run(sig, {}, 4096).events[0];
    expect(Math.abs(a.samples.length - b.samples.length)).toBeLessThan(SR * 0.02);
  });

  it("has documented defaults in the requested ranges", () => {
    expect(DEFAULT_ENDPOINT.preRollMs).toBeGreaterThanOrEqual(200);
    expect(DEFAULT_ENDPOINT.preRollMs).toBeLessThanOrEqual(300);
    expect(DEFAULT_ENDPOINT.hangoverMs).toBeGreaterThanOrEqual(400);
    expect(DEFAULT_ENDPOINT.hangoverMs).toBeLessThanOrEqual(700);
  });
});
