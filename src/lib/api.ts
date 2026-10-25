import { APP_VERSION, BUCKET, CONSENT_VERSION, SUPABASE_KEY, SUPABASE_URL } from "../config";

export interface SpeakerInput {
  display_name: string;
  age_band: string;
  gender: string;
  first_language: string;
  accent_note: string;
  country: string;
  region: string;
  mic_type: string;
  environment: string;
  campaign: string;
}

export interface RecordingRow {
  speaker_id: string;
  label: string;
  round: number;
  storage_path: string;
  sample_rate: number;
  native_sample_rate: number;
  duration_ms: number;
  peak_dbfs: number;
  rms_dbfs: number;
  noise_floor_dbfs: number;
  snr_db: number;
  clipped_fraction: number;
  quality_flag: string;
  retries: number;
  device_label: string;
  endpoint_reason: string;
}

/** Network failures and 5xx are worth retrying; a 4xx other than "already exists" will not fix itself. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public retryable: boolean) {
    super(message);
  }
}

const headers = (extra: Record<string, string> = {}) => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, ...extra });

async function call(url: string, init: RequestInit): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch (e: any) {
    throw new ApiError(0, e?.message ?? "network error", true);
  }
  return r;
}

async function fail(r: Response, what: string): Promise<never> {
  let detail = "";
  try { detail = (await r.text()).slice(0, 200); } catch { /* ignore */ }
  throw new ApiError(r.status, `${what} failed (${r.status}) ${detail}`.trim(), r.status >= 500 || r.status === 429 || r.status === 408);
}

/** What a participant has already recorded, looked up by their ID (see supabase/migrations/…my_progress_lookup.sql). */
export type Progress = { withdrawn: true } | { name: string; window_open: boolean; recorded: Array<[string, number]> } | null;

export async function fetchProgress(id: string): Promise<Progress> {
  const r = await call(`${SUPABASE_URL}/rest/v1/rpc/my_progress`, { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify({ p: id }) });
  if (!r.ok) await fail(r, "Looking up your ID");
  return (await r.json()) as Progress;
}

export interface Api {
  registerSpeaker(id: string, s: SpeakerInput): Promise<void>;
  uploadWav(path: string, wav: Blob): Promise<void>;
  insertRecording(row: RecordingRow): Promise<void>;
}

export const supabaseApi: Api = {
  async registerSpeaker(id, s) {
    const body = { id, ...s, adult_confirmed: true, consent_version: CONSENT_VERSION, consent_at: new Date().toISOString(), user_agent: navigator.userAgent.slice(0, 300), app_version: APP_VERSION };
    const r = await call(`${SUPABASE_URL}/rest/v1/speakers`, { method: "POST", headers: headers({ "Content-Type": "application/json", Prefer: "return=minimal" }), body: JSON.stringify(body) });
    if (r.status === 409) return; // already registered (retry after a lost response)
    if (!r.ok) await fail(r, "Registering");
  },
  async uploadWav(path, wav) {
    const r = await call(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, { method: "POST", headers: headers({ "Content-Type": "audio/wav", "x-upsert": "false", "cache-control": "3600" }), body: wav });
    if (r.status === 409) return; // an earlier attempt already stored this exact take; the path is unique to this speaker
    if (r.status === 400 && /KeyAlreadyExists|"statusCode":\s*"?409/.test(await r.clone().text().catch(() => ""))) return; // Supabase Storage reports "Duplicate" as HTTP 400
    if (!r.ok) await fail(r, "Uploading");
  },
  async insertRecording(row) {
    const r = await call(`${SUPABASE_URL}/rest/v1/recordings`, { method: "POST", headers: headers({ "Content-Type": "application/json", Prefer: "return=minimal" }), body: JSON.stringify(row) });
    if (r.status === 409) return; // unique(speaker, label, round): already recorded
    if (!r.ok) await fail(r, "Saving details");
  },
};
