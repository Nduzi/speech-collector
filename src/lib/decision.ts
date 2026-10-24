import { NO_SPEECH_MESSAGE, Quality } from "./quality";

export type Decision =
  | { action: "accept" }
  | { action: "retry"; message: string; speechless: boolean }
  | { action: "ignore" }; // a tap or bump while the screen was being touched: keep listening, say nothing

export interface Context {
  tries: number; // earlier failed attempts at this prompt that were not "no speech"
  maxRetries: number;
  uiDuringCapture: boolean; // the person touched the screen or a key while this take was being captured
  reason: string; // why capture ended: "endpoint" | "max_duration" | "manual"
}

/** What to do with a finished take. A take with no vowel in it is NEVER accepted, whatever else is true:
 *  that is what a screen tap, a bump or a double-tap on "Record manually" produces, and it must not
 *  count as a recording or move the person on. Other problems (quiet, noisy, clipped) are kept after
 *  a few retries, because there is still a spoken letter or number in them. */
export function decideTake(q: Quality, c: Context): Decision {
  if (q.speechless) {
    if (c.uiDuringCapture && c.reason !== "manual") return { action: "ignore" };
    return { action: "retry", message: q.message || NO_SPEECH_MESSAGE, speechless: true };
  }
  if (q.blocking && (c.tries < c.maxRetries || q.durationMs < 100)) return { action: "retry", message: q.message, speechless: false };
  return { action: "accept" };
}
