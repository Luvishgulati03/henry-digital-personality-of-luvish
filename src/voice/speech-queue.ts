/**
 * THE SPEECH QUEUE: every text-to-speech call in the dashboard process goes through one of these.
 *
 * The local TTS worker is single-threaded (Kokoro holds a synthesis lock), so synthesis is run
 * strictly one job at a time, here, where the order can be chosen:
 *
 * - FIFO per requester ("owner", "prompt", or a public visitor id), so one reply's sentences are
 *   synthesised in the order they will be spoken;
 * - round-robin ACROSS requesters, so one visitor's ten queued sentences cannot hold another
 *   visitor's first sentence (or the owner's) behind them;
 * - capped (pending jobs per requester and overall). A job over the cap is refused at once with
 *   `SpeechQueueFull`, never silently dropped later: the caller decides what to say.
 *
 * On top sits a small in-memory cache keyed by the caller (`<visitor>:<sentence id>:<part>`), so
 * a sentence can be synthesised the moment it is released and the page's request for it returns
 * the finished WAV, or waits only for the synthesis already in flight. Entries live `ttlMs` after
 * they finish and the cache holds at most `maxCachedBytes` of audio (oldest finished first out).
 */

export type SpeechSynthesize = (text: string, options?: { language?: string }) => Promise<Buffer>;

export class SpeechQueueFull extends Error {
  constructor() { super("The speech queue is full"); this.name = "SpeechQueueFull"; }
}

export class SpeechCancelled extends Error {
  constructor() { super("Speech was cancelled"); this.name = "SpeechCancelled"; }
}

export interface SpeechQueueOptions {
  /** Most jobs one requester may have waiting (not counting the one being synthesised). */
  maxPendingPerOwner?: number;
  /** Most jobs waiting overall. */
  maxPending?: number;
  /** How long a finished WAV stays cached. */
  ttlMs?: number;
  /** Cap on cached audio bytes. */
  maxCachedBytes?: number;
  now?: () => number;
}

interface Job {
  owner: string;
  text: string;
  language?: string;
  resolve: (audio: Buffer) => void;
  reject: (error: Error) => void;
  detach?: () => void;
}

interface CacheEntry {
  owner: string;
  promise: Promise<Buffer>;
  bytes: number;
  /** Infinity while the synthesis is pending or running. */
  expiresAt: number;
}

export const SPEECH_QUEUE_DEFAULTS = Object.freeze({
  maxPendingPerOwner: 16,
  maxPending: 48,
  ttlMs: 90_000,
  maxCachedBytes: 24 * 1024 * 1024,
});

export class SpeechQueue {
  private readonly pending = new Map<string, Job[]>();
  private readonly cache = new Map<string, CacheEntry>();
  private pendingCount = 0;
  private running = false;
  private readonly options: Required<Omit<SpeechQueueOptions, "now">>;
  private readonly now: () => number;

  constructor(private readonly synthesize: SpeechSynthesize, options: SpeechQueueOptions = {}) {
    this.options = {
      maxPendingPerOwner: options.maxPendingPerOwner ?? SPEECH_QUEUE_DEFAULTS.maxPendingPerOwner,
      maxPending: options.maxPending ?? SPEECH_QUEUE_DEFAULTS.maxPending,
      ttlMs: options.ttlMs ?? SPEECH_QUEUE_DEFAULTS.ttlMs,
      maxCachedBytes: options.maxCachedBytes ?? SPEECH_QUEUE_DEFAULTS.maxCachedBytes,
    };
    this.now = options.now ?? Date.now;
  }

  /** Jobs waiting (all requesters, or one). */
  size(owner?: string): number {
    return owner === undefined ? this.pendingCount : this.pending.get(owner)?.length ?? 0;
  }

  /** True while a synthesis is running. */
  get busy(): boolean { return this.running; }

  /**
   * Queues one synthesis for `owner`. Rejects with SpeechQueueFull at once when over a cap, and
   * with SpeechCancelled when `signal` aborts (or `cancel(owner)` runs) before the job starts.
   * A job already running is never interrupted: its audio is simply not used.
   */
  run(owner: string, text: string, options: { language?: string; signal?: AbortSignal } = {}): Promise<Buffer> {
    if (options.signal?.aborted) return Promise.reject(new SpeechCancelled());
    const queue = this.pending.get(owner) ?? [];
    if (queue.length >= this.options.maxPendingPerOwner || this.pendingCount >= this.options.maxPending) {
      return Promise.reject(new SpeechQueueFull());
    }
    return new Promise<Buffer>((resolve, reject) => {
      const job: Job = { owner, text, language: options.language, resolve, reject };
      if (options.signal) {
        const signal = options.signal;
        const onAbort = (): void => { if (this.remove(job)) reject(new SpeechCancelled()); };
        signal.addEventListener("abort", onAbort, { once: true });
        job.detach = () => signal.removeEventListener("abort", onAbort);
      }
      queue.push(job);
      this.pending.set(owner, queue);
      this.pendingCount += 1;
      this.pump();
    });
  }

  /**
   * Starts (or joins) the synthesis cached under `key`. Returns the cached promise when one is
   * pending or fresh; otherwise queues a new job. Throws SpeechQueueFull synchronously-as-rejected
   * like `run`. A failed synthesis leaves no cache entry, so the next call tries again.
   */
  cached(key: string, owner: string, text: string, options: { language?: string } = {}): Promise<Buffer> {
    this.sweep();
    const existing = this.cache.get(key);
    if (existing) return existing.promise;
    const entry: CacheEntry = { owner, bytes: 0, expiresAt: Number.POSITIVE_INFINITY, promise: Promise.resolve(Buffer.alloc(0)) };
    entry.promise = this.run(owner, text, options).then((audio) => {
      entry.bytes = audio.length;
      entry.expiresAt = this.now() + this.options.ttlMs;
      this.trim();
      return audio;
    }, (error: unknown) => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
      throw error;
    });
    // A prefetch nobody awaits must not become an unhandled rejection.
    entry.promise.catch(() => undefined);
    this.cache.set(key, entry);
    return entry.promise;
  }

  /** The cached (pending or finished) synthesis for `key`, if any. */
  peek(key: string): Promise<Buffer> | undefined {
    this.sweep();
    return this.cache.get(key)?.promise;
  }

  /**
   * Drops `owner`'s waiting jobs (they reject with SpeechCancelled) and forgets its cached audio.
   * The job being synthesised right now finishes; its result is not cached.
   */
  cancel(owner: string): number {
    const queue = this.pending.get(owner) ?? [];
    this.pending.delete(owner);
    this.pendingCount -= queue.length;
    for (const job of queue) { job.detach?.(); job.reject(new SpeechCancelled()); }
    for (const [key, entry] of this.cache) if (entry.owner === owner) this.cache.delete(key);
    return queue.length;
  }

  private remove(job: Job): boolean {
    const queue = this.pending.get(job.owner);
    const index = queue ? queue.indexOf(job) : -1;
    if (!queue || index < 0) return false;
    queue.splice(index, 1);
    this.pendingCount -= 1;
    if (!queue.length) this.pending.delete(job.owner);
    return true;
  }

  /** Round-robin: take the first requester in line, then move it to the back. */
  private next(): Job | undefined {
    for (const [owner, queue] of this.pending) {
      const job = queue.shift();
      this.pending.delete(owner);
      if (!job) continue;
      if (queue.length) this.pending.set(owner, queue);
      this.pendingCount -= 1;
      return job;
    }
    return undefined;
  }

  private pump(): void {
    if (this.running) return;
    const job = this.next();
    if (!job) return;
    this.running = true;
    job.detach?.();
    let result: Promise<Buffer>;
    try { result = this.synthesize(job.text, job.language ? { language: job.language } : undefined); } catch (error) { result = Promise.reject(error); }
    result.then(job.resolve, (error: unknown) => job.reject(error instanceof Error ? error : new Error(String(error))))
      .finally(() => { this.running = false; this.pump(); });
  }

  private sweep(): void {
    const at = this.now();
    for (const [key, entry] of this.cache) if (entry.expiresAt <= at) this.cache.delete(key);
  }

  private trim(): void {
    let total = 0;
    for (const entry of this.cache.values()) total += entry.bytes;
    for (const [key, entry] of this.cache) {
      if (total <= this.options.maxCachedBytes) break;
      if (entry.expiresAt === Number.POSITIVE_INFINITY) continue;
      this.cache.delete(key);
      total -= entry.bytes;
    }
  }
}
