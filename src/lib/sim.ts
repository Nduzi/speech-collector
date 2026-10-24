/** DEVELOPMENT ONLY (never bundled into the production build): a stand-in "microphone" that plays a synthetic
 *  room-tone + vowel-like burst in real time, so the recording flow can be exercised where no microphone exists.
 *  It is a test aid, not a recording of anything. */
export class SimSource {
  sampleRate = 48000;
  trackLabel = "Simulated input (dev)";
  trackSettings: MediaTrackSettings = {};
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private mode: "ok" | "quiet" | "loud" = "ok") {}

  async start(_s: unknown, onChunk: (c: Float32Array) => void) {
    const chunk = 960; // 20 ms
    let n = 0;
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
    const amp = this.mode === "quiet" ? 0.004 : this.mode === "loud" ? 1.5 : 0.3;
    this.timer = setInterval(() => {
      const out = new Float32Array(chunk);
      for (let i = 0; i < chunk; i++, n++) {
        const t = n / this.sampleRate;
        const cyc = t % 3.4; // quiet 1.4 s, burst 0.5 s, quiet 1.5 s
        let v = 0.0006 * rnd();
        if (cyc > 1.4 && cyc < 1.9) {
          const u = (cyc - 1.4) / 0.5;
          const env = Math.sin(Math.PI * u) ** 2;
          v += amp * env * (0.6 * Math.sin(2 * Math.PI * 140 * t) + 0.4 * Math.sin(2 * Math.PI * 700 * t) + 0.25 * Math.sin(2 * Math.PI * 1500 * t) + 0.05 * rnd());
        }
        out[i] = Math.max(-1, Math.min(1, v));
      }
      onChunk(out);
    }, 20);
    return { sampleRate: this.sampleRate, label: this.trackLabel, settings: this.trackSettings };
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  get active() { return this.timer != null; }
}
