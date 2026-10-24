/** Everything a deployer may want to change lives here. The publishable key is public by design:
 *  what it can do is limited by the row-level-security and storage policies in supabase/migrations. */
export const SUPABASE_URL = "https://vkoluuojtrsyagttzchx.supabase.co";
export const SUPABASE_KEY = "sb_publishable_cSfHob3T6LE8QcuP2-8xbw_uY3GdUVA";
export const BUCKET = "recordings";

export const CONTACT_EMAIL = "u19050667@tuks.co.za";
export const PROJECT_NAME = "Spoken letters and numbers";
export const INSTITUTION = "University of Pretoria";
/** Ethics clearance reference. Leave empty until one has been issued: it is only shown when set. */
export const ETHICS_REF = "";
/** Bump when the consent text changes; it is stored with every participant. */
export const CONSENT_VERSION = "2026-10-v1";
export const APP_VERSION = "1.0.0";

export interface Prompt { label: string; shown: string; spoken: string; kind: "letter" | "number" }
/** `label` is what is stored (and becomes the class folder name when exported); `shown` is the big glyph, `spoken` the word to say. */
export const PROMPTS: Prompt[] = [
  ..."ABCDEFGH".split("").map((l): Prompt => ({ label: l, shown: l, spoken: l, kind: "letter" })),
  ...["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"].map((w, i): Prompt => ({ label: w, shown: String(i + 1), spoken: w.toLowerCase(), kind: "number" })),
];

export const DEFAULT_ROUNDS = 5;
export const MAX_ROUNDS = 10;
export const TARGET_SR = 16000;
export const MAX_RETRIES_BEFORE_ACCEPT = 3;
