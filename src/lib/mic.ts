import { MicSource, MicSettings } from "./capture";

interface MicLike {
  start(s: MicSettings, onChunk: (c: Float32Array) => void): Promise<{ sampleRate: number; label: string; settings: MediaTrackSettings }>;
  stop(): void;
  readonly active: boolean;
}

/** One microphone for the whole visit: the mic-check and the recording screens share the open stream
 *  (so the browser asks permission once) and only swap the function that receives the audio. */
export class MicHandle {
  private source: MicLike | null = null;
  sampleRate = 0;
  label = "";
  flags = "";
  handler: (c: Float32Array) => void = () => undefined;

  async open(deviceId?: string) {
    this.close();
    let src: MicLike = new MicSource();
    if (import.meta.env.DEV) {
      const sim = new URLSearchParams(location.search).get("sim");
      if (sim) src = new (await import("./sim")).SimSource(sim === "quiet" ? "quiet" : sim === "loud" ? "loud" : "ok");
    }
    // Plain, unprocessed speech where the browser allows it; gain control stays on so quiet phones are usable.
    const info = await src.start({ deviceId, echoCancellation: false, noiseSuppression: false, autoGainControl: true }, (c) => this.handler(c));
    this.source = src;
    this.sampleRate = info.sampleRate;
    this.label = info.label;
    const s = info.settings;
    this.flags = ["agc", "ns", "ec"].map((k, i) => { const v = [s.autoGainControl, s.noiseSuppression, s.echoCancellation][i]; return v == null ? "" : `${k}${v ? 1 : 0}`; }).filter(Boolean).join(" ");
    return info;
  }

  close() {
    this.source?.stop();
    this.source = null;
  }

  get active() {
    return !!this.source?.active;
  }

  /** Stored with every take; at most 120 characters (database limit). */
  describe(): string {
    return `${this.label || "microphone"} | ${this.sampleRate} Hz${this.flags ? " | " + this.flags : ""}`.slice(0, 120);
  }
}
