import React from "react";

const P: Record<string, React.ReactNode> = {
  check: <path d="M3.2 8.6 6.6 12l6.2-7.4" />,
  mic: <><rect x="6" y="2" width="4" height="7" rx="2" /><path d="M3.8 7.6a4.2 4.2 0 0 0 8.4 0M8 11.8V14" /></>,
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" />,
  play: <path d="M5.2 3.4v9.2l7-4.6z" fill="currentColor" />,
  undo: <path d="M6 3.5 3 6.5l3 3M3.4 6.5H9a3.4 3.4 0 0 1 0 6.8H7" />,
  warn: <><path d="M8 2.6 14 13H2z" /><path d="M8 6.6v3M8 11.4v.1" /></>,
  info: <><circle cx="8" cy="8" r="5.6" /><path d="M8 7.2v3.6M8 5.2v.1" /></>,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.2" /><path d="M10.5 5.5v-2c0-.5-.4-.9-.9-.9H3.4c-.5 0-.9.4-.9.9v6.2c0 .5.4.9.9.9h2" /></>,
  up: <path d="M8 13V3.5M4.2 7.2 8 3.4l3.8 3.8" />,
  refresh: <path d="M13 8a5 5 0 1 1-1.6-3.6M13 2.8v3H10" />,
  stop: <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1" fill="currentColor" />,
};

export function Icon({ n, size = 16 }: { n: keyof typeof P; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {P[n]}
    </svg>
  );
}

/** A hand-drawn pen ellipse for the takes that are done. Slightly irregular on purpose. */
export function PenCircle() {
  return (
    <svg viewBox="0 0 40 28" preserveAspectRatio="none" aria-hidden className="pen">
      <path d="M21 2.6C11 1.6 2.6 6.4 3.4 14.2c.8 7.2 9.8 11.6 19.2 10.6C32 23.8 38.4 18.6 37 11.8 35.8 6 28.4 2.4 18.2 3.2" />
    </svg>
  );
}

export function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="currentColor" />
      <path d="M7 16h2M12 11v10M16 7v18M20 11v10M25 16h-2" stroke="var(--pen-ink)" strokeWidth="2.4" strokeLinecap="round" fill="none" />
    </svg>
  );
}
