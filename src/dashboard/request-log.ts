import type { RequestLogEntry, RouteCompleteEvent } from './types.js';

/**
 * Fixed-capacity ring buffer for request log entries.
 *
 * When the buffer is full, the oldest entry is overwritten.
 * All reads return entries in reverse chronological order (newest first).
 */
export class RequestLog {
  private readonly buffer: Array<RequestLogEntry | undefined>;
  private readonly capacity: number;
  private head = 0;
  private count = 0;
  private nextId = 1;
  private readonly listeners: Array<(entry: RequestLogEntry) => void> = [];

  constructor(capacity = 1000) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  /** Record a routing event, converting it to a log entry. */
  record(event: RouteCompleteEvent): RequestLogEntry {
    const entry: RequestLogEntry = {
      id: String(this.nextId++),
      timestamp: Date.now(),
      model: event.model,
      routingChain: event.steps,
      outcome: event.outcome,
      latencyMs: event.latencyMs,
      provider: event.provider,
    };

    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;

    for (const listener of this.listeners) {
      listener(entry);
    }

    return entry;
  }

  /** Get recent entries, newest first. */
  getRecent(limit?: number): RequestLogEntry[] {
    const n = Math.min(limit ?? this.count, this.count);
    const result: RequestLogEntry[] = [];

    let idx = (this.head - 1 + this.capacity) % this.capacity;
    for (let i = 0; i < n; i++) {
      const entry = this.buffer[idx];
      if (entry) result.push(entry);
      idx = (idx - 1 + this.capacity) % this.capacity;
    }

    return result;
  }

  /** Total entries ever recorded (not just current buffer contents). */
  get totalRecorded(): number {
    return this.nextId - 1;
  }

  /** Current number of entries in the buffer. */
  get size(): number {
    return this.count;
  }

  /** Subscribe to new entries. Returns an unsubscribe function. */
  onEntry(callback: (entry: RequestLogEntry) => void): () => void {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }
}
