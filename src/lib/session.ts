import { PROMPTS, Prompt } from "../config";

/** Everything needed to resume after a closed tab. Takes themselves live in IndexedDB until uploaded. */
export interface Session {
  v: 1;
  speakerId: string;
  name: string;
  createdAt: number;
  targetRounds: number;
  round: number; // 1-based, the round in progress
  done: Record<string, 1>; // take keys already accepted
  retries: Record<string, number>;
  finished: boolean;
}

const KEY = "speech-collector.session";
const THREE_DAYS = 3 * 24 * 3600 * 1000;

export const takeKey = (speakerId: string, label: string, round: number) => `${speakerId}/${label}_r${round}`;

export function loadSession(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return s && s.v === 1 && typeof s.speakerId === "string" ? (s as Session) : null;
  } catch {
    return null;
  }
}
export function saveSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch { /* private window: the session then lives for this visit only */ }
}
/** The server accepts new recordings for 3 days after registration. */
export const isExpired = (s: Session, now = Date.now()) => now - s.createdAt > THREE_DAYS - 3600 * 1000;

export function newSpeakerId(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/** A different but reproducible order for every speaker and round (so a resumed round keeps its order). */
export function roundOrder(speakerId: string, round: number): Prompt[] {
  const rnd = mulberry32(hash(`${speakerId}:${round}`));
  const a = [...PROMPTS];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** First round that still lacks a chess piece (used to carry on after the pieces were added). */
export function firstOpenRound(s: Session): number {
  for (let r = 1; r <= s.targetRounds; r++) if (PROMPTS.some((p) => p.kind === "piece" && !s.done[takeKey(s.speakerId, p.label, r)])) return r;
  return s.targetRounds;
}

/** How many chess-piece recordings this person still lacks across their rounds (people who started before the pieces were added). */
export function missingPieces(s: Session): number {
  let n = 0;
  for (let r = 1; r <= s.targetRounds; r++) for (const p of PROMPTS) if (p.kind === "piece" && !s.done[takeKey(s.speakerId, p.label, r)]) n++;
  return n;
}

export const totalTakes = (s: Session) => s.targetRounds * PROMPTS.length;
export const doneCount = (s: Session) => Object.keys(s.done).length;
export const shortId = (id: string) => id.slice(0, 8).toUpperCase();
