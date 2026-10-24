import { ApiError, Api, RecordingRow } from "./api";

export interface Job { key: string; row: RecordingRow; wav: Blob; attempts: number }

/** Where pending takes survive a closed tab. */
export interface JobStore {
  put(job: Job): Promise<void>;
  remove(key: string): Promise<void>;
  all(): Promise<Job[]>;
}

export interface QueueStatus { waiting: number; uploading: boolean; sent: number; failed: number; lastError: string }

type Timer = (fn: () => void, ms: number) => unknown;

/** Sequential upload queue with back-off. Storage first, then the metadata row; both calls are idempotent
 *  (a repeated upload or insert is answered with 409 and treated as success), so a retry after a lost
 *  response can never create a duplicate. */
export class UploadQueue {
  private jobs = new Map<string, Job>();
  private running = false;
  private sent = 0;
  private failed = new Map<string, string>();
  private lastError = "";
  private timer: unknown = null;
  private listeners = new Set<(s: QueueStatus) => void>();

  constructor(private api: Api, private store: JobStore, private opts: { baseDelayMs?: number; maxDelayMs?: number; maxAttempts?: number; setTimer?: Timer } = {}) {}

  onChange(fn: (s: QueueStatus) => void) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  status(): QueueStatus {
    return { waiting: this.jobs.size, uploading: this.running, sent: this.sent, failed: this.failed.size, lastError: this.lastError };
  }

  private emit() {
    const s = this.status();
    this.listeners.forEach((f) => f(s));
  }

  /** Reload jobs left over from an earlier visit. */
  async restore() {
    for (const j of await this.store.all()) this.jobs.set(j.key, j);
    this.emit();
    void this.pump();
  }

  async add(job: Job) {
    this.jobs.set(job.key, job);
    this.failed.delete(job.key);
    await this.store.put(job).catch(() => undefined); // persistence is a safety net, never a blocker
    this.emit();
    void this.pump();
  }

  /** Forget a job that has not been sent yet (the speaker re-recorded it). */
  async discard(key: string) {
    this.jobs.delete(key);
    this.failed.delete(key);
    await this.store.remove(key).catch(() => undefined);
    this.emit();
  }

  /** Try again now (e.g. the network came back), also for jobs that gave up. */
  retryNow() {
    this.failed.clear();
    if (this.timer != null) this.timer = null;
    void this.pump();
  }

  async drain(): Promise<void> {
    while (this.jobs.size && !this.failed.size) await new Promise((r) => setTimeout(r, 50));
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    this.emit();
    try {
      for (;;) {
        const job = [...this.jobs.values()].find((j) => !this.failed.has(j.key));
        if (!job) break;
        try {
          await this.api.uploadWav(job.row.storage_path, job.wav);
          await this.api.insertRecording(job.row);
          this.jobs.delete(job.key);
          await this.store.remove(job.key).catch(() => undefined);
          this.sent++;
          this.lastError = "";
        } catch (e: any) {
          job.attempts++;
          this.lastError = e?.message ?? String(e);
          const retryable = !(e instanceof ApiError) || e.retryable;
          if (!retryable || job.attempts >= (this.opts.maxAttempts ?? 12)) {
            this.failed.set(job.key, this.lastError);
          } else {
            this.schedule(job.attempts);
            break; // wait before touching the queue again
          }
        }
        this.emit();
      }
    } finally {
      this.running = false;
      this.emit();
    }
  }

  private schedule(attempt: number) {
    const base = this.opts.baseDelayMs ?? 1500;
    const delay = Math.min(this.opts.maxDelayMs ?? 30000, base * 2 ** Math.min(attempt - 1, 5));
    const set = this.opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = set(() => { this.timer = null; void this.pump(); }, delay);
  }
}

/** IndexedDB-backed store; silently unavailable in private windows etc. (the queue then works in memory only). */
export function indexedDbStore(): JobStore {
  const open = () => new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open("speech-collector", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("jobs", { keyPath: "key" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async <T,>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((res, rej) => {
      const t = db.transaction("jobs", mode);
      const rq = f(t.objectStore("jobs"));
      t.oncomplete = () => { db.close(); res(rq.result); };
      t.onerror = t.onabort = () => { db.close(); rej(t.error); };
    });
  };
  return {
    put: (job) => tx("readwrite", (s) => s.put(job)).then(() => undefined),
    remove: (key) => tx("readwrite", (s) => s.delete(key)).then(() => undefined),
    all: () => tx("readonly", (s) => s.getAll() as IDBRequest<Job[]>).catch(() => [] as Job[]),
  };
}
