import type { RateLimitWindow, AcquireResult } from './types.js';
import type { RateLimitOverride } from '../config/types.js';

/**
 * Internal mutable state for a single rate limit window.
 * The public-facing shape is RateLimitWindow (read-only snapshot).
 */
interface WindowState {
  type: RateLimitWindow['type'];
  remaining: number;
  total: number;
  resetsAt: Date;
  /** Duration of this window in milliseconds (e.g. 60_000 for RPM). */
  windowMs: number;
}

export interface RateLimiterConfig {
  /** Conservative seed RPM applied at cold start. Default 10. */
  seedRpm?: number;
  /** Per-provider overrides that replace cold-start defaults. */
  providerOverrides?: Record<string, RateLimitOverride[]>;
  /** Injectable clock for testing. Returns current time in ms since epoch. */
  now?: () => number;
}

const DEFAULT_SEED_RPM = 10;

const WINDOW_DURATION: Record<RateLimitWindow['type'], number> = {
  rpm: 60_000,
  rpd: 86_400_000,
  tpm: 60_000,
};

export class RateLimiter {
  private readonly windows: Map<string, WindowState[]> = new Map();
  private readonly seedRpm: number;
  private readonly providerOverrides: Record<string, RateLimitOverride[]>;
  private readonly now: () => number;
  constructor(config: RateLimiterConfig = {}) {
    this.seedRpm = config.seedRpm ?? DEFAULT_SEED_RPM;
    this.providerOverrides = config.providerOverrides ?? {};
    this.now = config.now ?? (() => Date.now());
  }

  /**
   * Atomically check and reserve capacity across all windows for a provider.
   *
   * For request windows (rpm/rpd) the cost is 1 request.
   * For token windows (tpm) the cost is `tokens` (caller-provided estimate).
   *
   * Returns `{ granted: true }` if all windows have capacity, or
   * `{ granted: false, waitMs }` where waitMs is the longest wait across
   * all exhausted windows.
   */
  acquire(providerId: string, tokens?: number): AcquireResult {
    const windows = this.ensureWindows(providerId);
    const currentMs = this.now();

    this.rolloverExpired(windows, currentMs);

    // Check ALL windows for capacity
    let maxWaitMs = 0;
    let allGranted = true;

    for (const w of windows) {
      const cost = this.costFor(w, tokens);
      if (cost === 0) continue;
      if (w.remaining < cost) {
        allGranted = false;
        const waitMs = Math.max(0, w.resetsAt.getTime() - currentMs);
        if (waitMs > maxWaitMs) {
          maxWaitMs = waitMs;
        }
      }
    }

    if (!allGranted) {
      return { granted: false, waitMs: maxWaitMs };
    }

    // Reserve capacity in all windows atomically
    for (const w of windows) {
      const cost = this.costFor(w, tokens);
      if (cost === 0) continue;
      w.remaining -= cost;
    }

    return { granted: true };
  }

  /**
   * Read-only snapshot of current rate limit windows for a provider.
   */
  getStatus(providerId: string): RateLimitWindow[] {
    const windows = this.ensureWindows(providerId);

    const currentMs = this.now();
    this.rolloverExpired(windows, currentMs);

    return windows.map((w) => ({
      type: w.type,
      remaining: w.remaining,
      total: w.total,
      resetsAt: new Date(w.resetsAt.getTime()),
    }));
  }

  /**
   * Parse x-ratelimit-* headers from a provider response to learn or update
   * rate limit windows. Header-reported limits are authoritative and override
   * internal tracking.
   *
   * Supports two header conventions seen in the wild:
   *
   *   Base format (Groq, GitHub Models):
   *     x-ratelimit-limit-requests / x-ratelimit-remaining-requests
   *     x-ratelimit-limit-tokens  / x-ratelimit-remaining-tokens
   *     x-ratelimit-reset-requests (duration string, e.g. "6s", "440ms")
   *
   *   Suffixed format (Cerebras, SambaNova):
   *     x-ratelimit-limit-requests-minute / -day
   *     x-ratelimit-remaining-requests-minute / -day
   *     x-ratelimit-reset-requests-day (unix timestamp or duration)
   *     (same pattern for tokens)
   */
  recordRateLimitResponse(providerId: string, headers: Headers): void {
    const windows = this.ensureWindows(providerId);
    const currentMs = this.now();

    this.rolloverExpired(windows, currentMs);

    // --- Request windows ---

    // RPM: base headers or -minute suffix
    this.learnWindow(windows, headers, currentMs, {
      type: 'rpm',
      limitNames: ['x-ratelimit-limit-requests', 'x-ratelimit-limit-requests-minute'],
      remainingNames: ['x-ratelimit-remaining-requests', 'x-ratelimit-remaining-requests-minute'],
      resetNames: ['x-ratelimit-reset-requests', 'x-ratelimit-reset-requests-minute'],
      windowMs: WINDOW_DURATION.rpm,
    });

    // RPD: -day suffix
    this.learnWindow(windows, headers, currentMs, {
      type: 'rpd',
      limitNames: ['x-ratelimit-limit-requests-day'],
      remainingNames: ['x-ratelimit-remaining-requests-day'],
      resetNames: ['x-ratelimit-reset-requests-day'],
      windowMs: WINDOW_DURATION.rpd,
    });

    // --- Token windows ---

    // TPM: base headers or -minute suffix
    this.learnWindow(windows, headers, currentMs, {
      type: 'tpm',
      limitNames: ['x-ratelimit-limit-tokens', 'x-ratelimit-limit-tokens-minute'],
      remainingNames: ['x-ratelimit-remaining-tokens', 'x-ratelimit-remaining-tokens-minute'],
      resetNames: ['x-ratelimit-reset-tokens', 'x-ratelimit-reset-tokens-minute'],
      windowMs: WINDOW_DURATION.tpm,
    });
  }

  /**
   * Correct a previous token reservation after the actual usage is known.
   *
   * The caller passes both the `estimatedTokens` it originally reserved
   * (via acquire) and the `actualTokens` consumed. This eliminates shared
   * mutable state and is safe under concurrent requests to the same provider.
   *
   * If `actualTokens` is undefined, the estimate is kept (no-op).
   */
  reconcile(providerId: string, estimatedTokens: number, actualTokens?: number): void {
    if (actualTokens === undefined) return;

    const windows = this.windows.get(providerId);
    if (!windows) return;

    const currentMs = this.now();
    this.rolloverExpired(windows, currentMs);

    const tpmWindow = windows.find((w) => w.type === 'tpm');
    if (!tpmWindow) return;

    const delta = estimatedTokens - actualTokens;

    // Give back unused tokens (positive delta) or consume more (negative delta)
    tpmWindow.remaining += delta;

    // Clamp: remaining cannot exceed total
    if (tpmWindow.remaining > tpmWindow.total) {
      tpmWindow.remaining = tpmWindow.total;
    }
  }

  // ---- Private helpers ----

  private costFor(w: WindowState, tokens: number | undefined): number {
    if (w.type === 'tpm') {
      return tokens ?? 0;
    }
    return 1;
  }

  private ensureWindows(providerId: string): WindowState[] {
    let windows = this.windows.get(providerId);
    if (!windows) {
      windows = this.createInitialWindows(providerId);
      this.windows.set(providerId, windows);
    }
    return windows;
  }

  private createInitialWindows(providerId: string): WindowState[] {
    const overrides = this.providerOverrides[providerId];
    if (overrides && overrides.length > 0) {
      const currentMs = this.now();
      return overrides.map((o) => ({
        type: o.type,
        total: o.total,
        remaining: o.total,
        resetsAt: new Date(currentMs + o.windowMs),
        windowMs: o.windowMs,
      }));
    }

    // Conservative cold start: single RPM window
    const currentMs = this.now();
    return [
      {
        type: 'rpm' as const,
        total: this.seedRpm,
        remaining: this.seedRpm,
        resetsAt: new Date(currentMs + WINDOW_DURATION.rpm),
        windowMs: WINDOW_DURATION.rpm,
      },
    ];
  }

  private rolloverExpired(windows: WindowState[], currentMs: number): void {
    for (const w of windows) {
      if (currentMs >= w.resetsAt.getTime()) {
        w.remaining = w.total;
        w.resetsAt = new Date(currentMs + w.windowMs);
      }
    }
  }

  /**
   * Try to learn a single window type from response headers.
   * Checks multiple header name variants (base format, suffixed format)
   * and takes the first match found.
   */
  private learnWindow(
    windows: WindowState[],
    headers: Headers,
    currentMs: number,
    spec: {
      type: RateLimitWindow['type'];
      limitNames: string[];
      remainingNames: string[];
      resetNames: string[];
      windowMs: number;
    },
  ): void {
    const limit = this.firstHeaderNumber(headers, spec.limitNames);
    if (limit === undefined) return;

    const remaining = this.firstHeaderNumber(headers, spec.remainingNames);
    const resetMs = this.firstHeaderReset(headers, spec.resetNames, currentMs);

    this.upsertWindow(windows, {
      type: spec.type,
      total: limit,
      remaining: remaining ?? limit,
      resetsAt: new Date(currentMs + (resetMs ?? spec.windowMs)),
      windowMs: spec.windowMs,
    });
  }

  private upsertWindow(windows: WindowState[], incoming: WindowState): void {
    const existing = windows.find((w) => w.type === incoming.type);
    if (existing) {
      // Header-reported limits are authoritative
      existing.total = incoming.total;
      existing.remaining = incoming.remaining;
      existing.resetsAt = incoming.resetsAt;
      existing.windowMs = incoming.windowMs;
    } else {
      windows.push(incoming);
    }
  }

  /** Return the first defined numeric header value from a list of names. */
  private firstHeaderNumber(headers: Headers, names: string[]): number | undefined {
    for (const name of names) {
      const value = headers.get(name);
      if (value === null || value === undefined) continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  }

  /**
   * Return the first parseable reset value (as ms-until-reset) from a list
   * of header names. Handles duration strings ("6s", "440ms") and unix
   * timestamps (e.g. 1771802517).
   */
  private firstHeaderReset(
    headers: Headers,
    names: string[],
    currentMs: number,
  ): number | undefined {
    for (const name of names) {
      const value = headers.get(name);
      if (value === null || value === undefined) continue;
      const result = this.parseResetValue(value, currentMs);
      if (result !== undefined) return result;
    }
    return undefined;
  }

  /**
   * Parse a rate limit reset value into milliseconds-until-reset.
   *
   * Handles three formats seen in the wild:
   *   - Duration strings: "6s", "440ms", "1m30s" (Groq)
   *   - Unix timestamps: 1771802517 (SambaNova) — seconds since epoch
   *   - Plain seconds: "60" — small numbers treated as duration
   */
  private parseResetValue(value: string, currentMs: number): number | undefined {
    // If it contains letters, parse as duration string
    if (/[a-zA-Z]/.test(value)) {
      return this.parseDuration(value);
    }

    // Plain number — distinguish timestamp from duration
    const num = Number(value);
    if (!Number.isFinite(num)) return undefined;

    // Numbers > 1 billion are unix timestamps (seconds since epoch)
    if (num > 1_000_000_000) {
      return Math.max(0, num * 1000 - currentMs);
    }

    // Small numbers are duration in seconds
    return num * 1000;
  }

  /**
   * Parse a duration string like "6s", "440ms", "1m30s", "1d2h".
   * Returns milliseconds.
   */
  private parseDuration(value: string): number | undefined {
    let totalMs = 0;
    let matched = false;

    const msMatch = value.match(/(\d+)ms/);
    if (msMatch) { totalMs += Number(msMatch[1]); matched = true; }

    const dayMatch = value.match(/(\d+)d/);
    if (dayMatch) { totalMs += Number(dayMatch[1]) * 86_400_000; matched = true; }

    const hourMatch = value.match(/(\d+)h/);
    if (hourMatch) { totalMs += Number(hourMatch[1]) * 3_600_000; matched = true; }

    // Match minutes: digits followed by 'm' but NOT 'ms'
    const minMatch = value.match(/(\d+)m(?!s)/);
    if (minMatch) { totalMs += Number(minMatch[1]) * 60_000; matched = true; }

    // Match seconds: digits immediately followed by 's'. Won't match the 's' in 'ms'
    // because 'm' separates the digits from 's' in patterns like '500ms'.
    const secMatch = value.match(/(\d+)s/);
    if (secMatch) { totalMs += Number(secMatch[1]) * 1_000; matched = true; }

    return matched ? totalMs : undefined;
  }
}
