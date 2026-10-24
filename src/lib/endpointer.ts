/**
 * Speech onset / endpoint detection for live capture.
 *
 * Not a generic VAD: it tracks the noise floor of two bands - full band and a crude high-pass
 * (first difference) band - and triggers on EITHER. The high band exists because the initial /s/ of
 * "C" carries almost all its energy at high frequencies and can sit below a full-band threshold.
 * A pre-roll ring buffer then keeps audio from *before* the trigger so weak onsets and bursts are
 * not clipped, and an endpoint hangover keeps the tail.
 *
 * Pure logic (no DOM) so it can be unit-tested with synthetic signals.
 */
export interface EndpointConfig {
  preRollMs: number;
  hangoverMs: number;
  maxDurationMs: number;
  noSpeechTimeoutMs: number;
  onsetDb: number; // full band: dB above noise floor
  hfOnsetDb: number; // high band: dB above its own floor
  offsetDb: number; // hysteresis for "speech has stopped"
  minOnsetMs: number;
  minSpeechMs: number;
  minLevelDb: number; // absolute floor for full-band triggering (dBFS)
  minHfLevelDb: number;
  calibrationMs: number;
}

export const DEFAULT_ENDPOINT: EndpointConfig = {
  preRollMs: 300,
  hangoverMs: 550,
  maxDurationMs: 4000,
  noSpeechTimeoutMs: 8000,
  onsetDb: 10,
  hfOnsetDb: 8,
  offsetDb: 4,
  minOnsetMs: 30,
  minSpeechMs: 60,
  minLevelDb: -62,
  minHfLevelDb: -70,
  calibrationMs: 300,
};

export type EpState = "idle" | "listening" | "speech";
export type EndReason = "endpoint" | "max_duration" | "manual";

export interface EndpointHooks {
  onState?: (s: EpState) => void;
  onLevel?: (levelDb: number, floorDb: number, hfDb: number) => void;
  onUtterance?: (u: { samples: Float32Array; sampleRate: number; reason: EndReason; speechMs: number; floorDb: number; hfFloorDb: number }) => void;
  onNoSpeech?: () => void;
}

const db = (x: number) => 10 * Math.log10(x + 1e-12);

export class Endpointer {
  readonly sr: number;
  private hop: number;
  private cfg: EndpointConfig;
  private hooks: EndpointHooks;
  private carry = new Float32Array(0);
  private lastSample = 0;
  private frames: Float32Array[] = []; // ring buffer (pre-roll + a little context)
  private maxRing: number;
  private rec: Float32Array[] | null = null;
  state: EpState = "idle";
  private calib: number[] = [];
  private calibHf: number[] = [];
  private floor = -90;
  private hfFloor = -90;
  private calibrated = false;
  private onsetRun = 0;
  private belowRun = 0; // frames since the last sustained activity
  private activeRun = 0;
  private activeFrames = 0;
  private framesSinceListen = 0;
  private manual = false;

  constructor(sampleRate: number, cfg: Partial<EndpointConfig> = {}, hooks: EndpointHooks = {}) {
    this.sr = sampleRate;
    this.cfg = { ...DEFAULT_ENDPOINT, ...cfg };
    this.hooks = hooks;
    this.hop = Math.max(1, Math.round(sampleRate * 0.01));
    this.maxRing = Math.ceil((this.cfg.preRollMs + 100) / 10) + Math.ceil(this.cfg.minOnsetMs / 10) + 2;
  }

  get noiseFloorDb() {
    return this.floor;
  }

  private setState(s: EpState) {
    if (s !== this.state) {
      this.state = s;
      this.hooks.onState?.(s);
    }
  }

  /** Begin listening (re-calibrates the noise floor from the first calibrationMs). */
  listen() {
    this.frames = [];
    this.rec = null;
    this.calib = [];
    this.calibHf = [];
    this.calibrated = false;
    this.onsetRun = this.belowRun = this.activeRun = this.activeFrames = this.framesSinceListen = 0;
    this.manual = false;
    this.setState("listening");
  }

  stop() {
    this.rec = null;
    this.setState("idle");
  }

  /** Manual fallback: start recording now (with pre-roll) regardless of the detector. */
  forceStart() {
    if (this.state === "idle") this.listen();
    this.manual = true;
    this.beginRecording(this.frames.length);
  }

  /** Manual fallback: end the current recording now. */
  forceStop() {
    if (this.rec) this.finish("manual");
  }

  push(chunk: Float32Array) {
    if (this.state === "idle") return;
    let buf: Float32Array;
    if (this.carry.length) {
      buf = new Float32Array(this.carry.length + chunk.length);
      buf.set(this.carry);
      buf.set(chunk, this.carry.length);
    } else buf = chunk;
    let i = 0;
    while (i + this.hop <= buf.length && (this.state as EpState) !== "idle") {
      this.frame(buf.subarray(i, i + this.hop).slice());
      i += this.hop;
    }
    this.carry = buf.slice(i);
  }

  private frame(f: Float32Array) {
    let e = 0;
    let d = 0;
    let prev = this.lastSample;
    for (let k = 0; k < f.length; k++) {
      e += f[k] * f[k];
      const x = f[k] - prev;
      d += x * x;
      prev = f[k];
    }
    this.lastSample = prev;
    const lvl = db(e / f.length);
    const hf = db(d / f.length);
    this.hooks.onLevel?.(lvl, this.floor, hf);
    this.framesSinceListen++;
    const c = this.cfg;

    // ---- calibration of the noise floor
    if (!this.calibrated) {
      this.calib.push(lvl);
      this.calibHf.push(hf);
      this.pushRing(f);
      if (this.calib.length * 10 >= c.calibrationMs) {
        const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
        this.floor = Math.max(med(this.calib), -85);
        this.hfFloor = Math.max(med(this.calibHf), -85);
        this.calibrated = true;
      }
      return;
    }

    const loud = lvl > Math.max(this.floor + c.onsetDb, c.minLevelDb);
    // no extra full-band condition here: with LF-dominated room noise a weak /s/ barely moves the full band
    const hfLoud = hf > Math.max(this.hfFloor + c.hfOnsetDb, c.minHfLevelDb);
    const active = loud || hfLoud;

    if (this.state === "listening") {
      this.pushRing(f);
      if (active) this.onsetRun++;
      else {
        this.onsetRun = 0;
        // slowly follow the background while nothing is happening
        const a = lvl > this.floor ? 0.02 : 0.2;
        this.floor += (lvl - this.floor) * a;
        this.hfFloor += (hf - this.hfFloor) * (hf > this.hfFloor ? 0.02 : 0.2);
      }
      if (this.onsetRun * 10 >= c.minOnsetMs) {
        const startIdx = Math.max(0, this.frames.length - this.onsetRun - Math.ceil(c.preRollMs / 10));
        this.beginRecording(startIdx);
        this.activeFrames = this.onsetRun;
      } else if (c.noSpeechTimeoutMs > 0 && this.framesSinceListen * 10 > c.noSpeechTimeoutMs) {
        this.setState("idle");
        this.hooks.onNoSpeech?.();
      }
      return;
    }

    // ---- state === "speech": record, look for the endpoint.
    // The utterance ends when nothing *sustained* (>= 2 consecutive frames above the ONSET threshold) has happened for
    // `hangoverMs`. The old rule demanded an unbroken run of frames below floor+offsetDb, which real (non-stationary)
    // room noise interrupts constantly, so recordings ran to the maximum length.
    this.rec!.push(f);
    if (active) {
      this.activeFrames++;
      this.activeRun++;
      if (this.activeRun >= 2) this.belowRun = 0;
    } else {
      this.activeRun = 0;
    }
    if (!active || this.activeRun < 2) this.belowRun++;
    if (!this.manual && this.belowRun * 10 >= c.hangoverMs) this.finish("endpoint");
    else if (this.rec!.length * 10 >= c.maxDurationMs) this.finish("max_duration");
  }

  private pushRing(f: Float32Array) {
    this.frames.push(f);
    if (this.frames.length > this.maxRing) this.frames.shift();
  }

  private beginRecording(startIdx: number) {
    this.rec = this.frames.slice(startIdx);
    this.belowRun = 0;
    this.activeRun = this.onsetRun;
    this.setState("speech");
  }

  private finish(reason: EndReason) {
    const rec = this.rec!;
    this.rec = null;
    const speechMs = this.activeFrames * 10;
    if (reason === "endpoint" && speechMs < this.cfg.minSpeechMs) {
      // a click or blip: ignore it and keep listening
      this.onsetRun = 0;
      this.frames = [];
      this.setState("listening");
      return;
    }
    const n = rec.reduce((s, x) => s + x.length, 0);
    const out = new Float32Array(n);
    let o = 0;
    for (const x of rec) {
      out.set(x, o);
      o += x.length;
    }
    this.setState("idle");
    this.hooks.onUtterance?.({ samples: out, sampleRate: this.sr, reason, speechMs, floorDb: this.floor, hfFloorDb: this.hfFloor });
  }
}

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}
