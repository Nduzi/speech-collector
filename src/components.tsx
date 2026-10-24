import { MutableRefObject, useEffect, useRef } from "react";

/** A level bar driven straight from a ref on every animation frame (no React re-render per audio chunk). */
export function LevelMeter({ levelRef, floorRef, label = "Microphone level" }: { levelRef: MutableRefObject<number>; floorRef?: MutableRefObject<number>; label?: string }) {
  const bar = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    let shown = 0;
    const to01 = (db: number) => Math.max(0, Math.min(1, (db + 70) / 60)); // -70 dBFS .. -10 dBFS
    const tick = () => {
      const v = to01(levelRef.current);
      shown = v > shown ? v : shown * 0.85 + v * 0.15; // quick attack, slower release
      if (bar.current) bar.current.style.transform = `scaleX(${shown})`;
      if (mark.current && floorRef) mark.current.style.left = `${to01(floorRef.current) * 100}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [levelRef, floorRef]);
  return (
    <div className="meter" role="img" aria-label={label}>
      <div className="meter-bar" ref={bar} />
      {floorRef && <div className="meter-floor" ref={mark} title="background level" />}
    </div>
  );
}

export const dbOfChunk = (x: Float32Array) => {
  let e = 0;
  for (let i = 0; i < x.length; i++) e += x[i] * x[i];
  return 10 * Math.log10(e / Math.max(1, x.length) + 1e-12);
};
