import { PROMPTS } from "../config";
import { Session, takeKey } from "./session";

/** A link the project owner sends to one participant so they can finish what is still missing, from any device:
 *    ?add=<participant id>&n=<first name>&r=<rounds>&p=<number of prompts>&m=<missing, base 36>
 *  `m` is a bit set: bit (round - 1) * prompts + promptIndex is 1 when that recording is still needed.
 *  The link only works while the owner has re-opened the participant's upload window. */
export interface ResumeLink { speakerId: string; name: string; rounds: number; missing: Set<string> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeMissing(missing: Array<[round: number, promptIndex: number]>): string {
  let m = 0n;
  for (const [r, i] of missing) m |= 1n << BigInt((r - 1) * PROMPTS.length + i);
  return m.toString(36);
}

export function decodeMissing(mask: string): Array<[number, number]> {
  let m = 0n;
  for (const ch of mask) {
    const d = parseInt(ch, 36);
    if (Number.isNaN(d)) throw new Error("bad mask");
    m = m * 36n + BigInt(d);
  }
  const out: Array<[number, number]> = [];
  for (let bit = 0; m >> BigInt(bit) > 0n; bit++) if ((m >> BigInt(bit)) & 1n) out.push([Math.floor(bit / PROMPTS.length) + 1, bit % PROMPTS.length]);
  return out;
}

export function parseResumeLink(search: string): ResumeLink | null {
  const q = new URLSearchParams(search);
  const id = (q.get("add") ?? "").toLowerCase();
  const rounds = Number(q.get("r"));
  const m = (q.get("m") ?? "").toLowerCase();
  const name = (q.get("n") ?? "").trim().slice(0, 60);
  if (!UUID.test(id) || !Number.isInteger(rounds) || rounds < 1 || rounds > 10 || !/^[0-9a-z]{0,60}$/.test(m)) return null;
  if (Number(q.get("p")) !== PROMPTS.length) return null; // the list of words changed since the link was made
  try {
    const missing = new Set<string>();
    for (const [r, i] of decodeMissing(m)) {
      if (r > rounds || i >= PROMPTS.length) return null;
      missing.add(takeKey(id, PROMPTS[i].label, r));
    }
    return { speakerId: id, name, rounds, missing };
  } catch {
    return null;
  }
}

/** The session this link stands for: everything is done except what the owner says is still missing. */
export function sessionFromLink(l: ResumeLink, now = Date.now()): Session {
  const done: Record<string, 1> = {};
  let first = 0;
  for (let r = 1; r <= l.rounds; r++) {
    for (const p of PROMPTS) {
      const k = takeKey(l.speakerId, p.label, r);
      if (l.missing.has(k)) { if (!first) first = r; } else done[k] = 1;
    }
  }
  return { v: 1, speakerId: l.speakerId, name: l.name, createdAt: now, targetRounds: l.rounds, round: first || l.rounds, done, retries: {}, finished: first === 0 };
}
