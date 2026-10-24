/** Band-limited resampling by windowed-sinc interpolation (Kaiser-free Hann window; adequate for speech at 16 kHz).
 *  When downsampling, the kernel cut-off is lowered to the target Nyquist so nothing aliases back into the band. */
export function resample(x: Float32Array, from: number, to: number, halfWidth = 16): Float32Array {
  if (from === to) return x.slice();
  const ratio = from / to; // input samples per output sample
  const n = Math.floor(x.length / ratio);
  const out = new Float32Array(n);
  const cutoff = Math.min(1, to / from); // fraction of input Nyquist kept
  const support = Math.ceil(halfWidth / cutoff);
  for (let i = 0; i < n; i++) {
    const t = i * ratio;
    const c = Math.floor(t);
    let acc = 0;
    let norm = 0;
    for (let k = c - support + 1; k <= c + support; k++) {
      if (k < 0 || k >= x.length) continue;
      const d = (t - k) * cutoff;
      const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      const w = 0.5 * (1 + Math.cos((Math.PI * (t - k)) / support));
      const h = sinc * w * cutoff;
      acc += x[k] * h;
      norm += h;
    }
    out[i] = norm > 1e-6 ? acc / norm : 0; // normalising by the kernel sum also fixes the gain at the signal edges
  }
  return out;
}
