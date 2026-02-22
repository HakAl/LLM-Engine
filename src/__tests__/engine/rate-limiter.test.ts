import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from '../../engine/rate-limiter.js';

describe('RateLimiter', () => {
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    clock = 1_000_000;
  });

  // ----------------------------------------------------------------
  // Cold start with seed RPM
  // ----------------------------------------------------------------
  describe('cold start', () => {
    it('creates a single RPM window with seed capacity on first acquire', () => {
      const limiter = new RateLimiter({ seedRpm: 5, now });

      // Windows are lazily created on first acquire
      limiter.acquire('openai');

      const status = limiter.getStatus('openai');
      expect(status).toHaveLength(1);
      expect(status[0].type).toBe('rpm');
      expect(status[0].total).toBe(5);
      expect(status[0].remaining).toBe(4); // 1 already consumed
    });

    it('defaults seed RPM to 10', () => {
      const limiter = new RateLimiter({ now });

      limiter.acquire('openai');

      const status = limiter.getStatus('openai');
      expect(status[0].total).toBe(10);
    });
  });

  // ----------------------------------------------------------------
  // acquire() basic behavior
  // ----------------------------------------------------------------
  describe('acquire', () => {
    it('grants requests when capacity exists', () => {
      const limiter = new RateLimiter({ seedRpm: 3, now });

      expect(limiter.acquire('p1')).toEqual({ granted: true });
      expect(limiter.acquire('p1')).toEqual({ granted: true });
      expect(limiter.acquire('p1')).toEqual({ granted: true });

      const status = limiter.getStatus('p1');
      expect(status[0].remaining).toBe(0);
    });

    it('denies requests when capacity exhausted', () => {
      const limiter = new RateLimiter({ seedRpm: 1, now });

      expect(limiter.acquire('p1')).toEqual({ granted: true });

      const result = limiter.acquire('p1');
      expect(result.granted).toBe(false);
      expect(result.waitMs).toBeGreaterThan(0);
    });

    it('returns waitMs as time until window reset', () => {
      const limiter = new RateLimiter({ seedRpm: 1, now });
      limiter.acquire('p1');

      const result = limiter.acquire('p1');
      expect(result.granted).toBe(false);
      // Window resets at clock + 60_000ms, so waitMs should be 60_000
      expect(result.waitMs).toBe(60_000);
    });

    it('tracks providers independently', () => {
      const limiter = new RateLimiter({ seedRpm: 1, now });

      expect(limiter.acquire('p1')).toEqual({ granted: true });
      expect(limiter.acquire('p2')).toEqual({ granted: true });

      expect(limiter.acquire('p1').granted).toBe(false);
      expect(limiter.acquire('p2').granted).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // Window rollover
  // ----------------------------------------------------------------
  describe('window rollover', () => {
    it('replenishes capacity after window expires', () => {
      const limiter = new RateLimiter({ seedRpm: 1, now });

      expect(limiter.acquire('p1')).toEqual({ granted: true });
      expect(limiter.acquire('p1').granted).toBe(false);

      // Advance past the 60s window
      clock += 60_001;

      expect(limiter.acquire('p1')).toEqual({ granted: true });
    });

    it('resets remaining to total on rollover', () => {
      const limiter = new RateLimiter({ seedRpm: 3, now });

      limiter.acquire('p1');
      limiter.acquire('p1');

      clock += 60_001;

      const status = limiter.getStatus('p1');
      expect(status[0].remaining).toBe(3);
    });
  });

  // ----------------------------------------------------------------
  // Provider overrides
  // ----------------------------------------------------------------
  describe('provider overrides', () => {
    it('uses configured overrides instead of seed RPM', () => {
      const limiter = new RateLimiter({
        now,
        providerOverrides: {
          groq: [
            { type: 'rpm', total: 30, windowMs: 60_000 },
            { type: 'tpm', total: 10_000, windowMs: 60_000 },
          ],
        },
      });

      // Trigger window creation
      limiter.acquire('groq', 100);

      const status = limiter.getStatus('groq');
      expect(status).toHaveLength(2);
      expect(status[0].type).toBe('rpm');
      expect(status[0].total).toBe(30);
      expect(status[1].type).toBe('tpm');
      expect(status[1].total).toBe(10_000);
    });

    it('falls back to seed RPM for providers without overrides', () => {
      const limiter = new RateLimiter({
        seedRpm: 5,
        now,
        providerOverrides: {
          groq: [{ type: 'rpm', total: 30, windowMs: 60_000 }],
        },
      });

      limiter.acquire('openai');

      const status = limiter.getStatus('openai');
      expect(status).toHaveLength(1);
      expect(status[0].total).toBe(5);
    });
  });

  // ----------------------------------------------------------------
  // Token (TPM) windows
  // ----------------------------------------------------------------
  describe('token windows', () => {
    it('deducts token cost from TPM windows', () => {
      const limiter = new RateLimiter({
        now,
        providerOverrides: {
          p1: [
            { type: 'rpm', total: 100, windowMs: 60_000 },
            { type: 'tpm', total: 1000, windowMs: 60_000 },
          ],
        },
      });

      expect(limiter.acquire('p1', 200)).toEqual({ granted: true });

      const status = limiter.getStatus('p1');
      const rpm = status.find(w => w.type === 'rpm')!;
      const tpm = status.find(w => w.type === 'tpm')!;

      expect(rpm.remaining).toBe(99); // -1 request
      expect(tpm.remaining).toBe(800); // -200 tokens
    });

    it('denies when token capacity exhausted', () => {
      const limiter = new RateLimiter({
        now,
        providerOverrides: {
          p1: [{ type: 'tpm', total: 500, windowMs: 60_000 }],
        },
      });

      expect(limiter.acquire('p1', 400)).toEqual({ granted: true });
      const result = limiter.acquire('p1', 200);
      expect(result.granted).toBe(false);
      expect(result.waitMs).toBe(60_000);
    });

    it('skips token cost when tokens is undefined', () => {
      const limiter = new RateLimiter({
        now,
        providerOverrides: {
          p1: [
            { type: 'rpm', total: 10, windowMs: 60_000 },
            { type: 'tpm', total: 1000, windowMs: 60_000 },
          ],
        },
      });

      expect(limiter.acquire('p1')).toEqual({ granted: true });

      const status = limiter.getStatus('p1');
      const tpm = status.find(w => w.type === 'tpm')!;
      expect(tpm.remaining).toBe(1000); // no tokens deducted
    });
  });

  // ----------------------------------------------------------------
  // Multi-window: longest waitMs wins
  // ----------------------------------------------------------------
  describe('multi-window acquire', () => {
    it('returns max waitMs across all exhausted windows', () => {
      const limiter = new RateLimiter({
        now,
        providerOverrides: {
          p1: [
            { type: 'rpm', total: 1, windowMs: 60_000 },
            { type: 'rpd', total: 1, windowMs: 86_400_000 },
          ],
        },
      });

      limiter.acquire('p1');
      const result = limiter.acquire('p1');
      expect(result.granted).toBe(false);
      // RPD window has longer reset: 86_400_000 > 60_000
      expect(result.waitMs).toBe(86_400_000);
    });

    it('denies if any window lacks capacity', () => {
      const limiter = new RateLimiter({
        now,
        providerOverrides: {
          p1: [
            { type: 'rpm', total: 1, windowMs: 60_000 },
            { type: 'tpm', total: 10_000, windowMs: 60_000 },
          ],
        },
      });

      limiter.acquire('p1', 100);
      // RPM exhausted but TPM still has capacity
      const result = limiter.acquire('p1', 100);
      expect(result.granted).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // recordRateLimitResponse — header learning
  // ----------------------------------------------------------------
  describe('recordRateLimitResponse', () => {
    it('updates windows from request rate-limit headers', () => {
      const limiter = new RateLimiter({ now });

      const headers = new Headers({
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '42',
        'x-ratelimit-reset-requests': '30s',
      });

      limiter.recordRateLimitResponse('p1', headers);

      const status = limiter.getStatus('p1');
      const rpm = status.find(w => w.type === 'rpm')!;
      expect(rpm.total).toBe(100);
      expect(rpm.remaining).toBe(42);
    });

    it('updates windows from token rate-limit headers', () => {
      const limiter = new RateLimiter({ now });

      const headers = new Headers({
        'x-ratelimit-limit-tokens': '50000',
        'x-ratelimit-remaining-tokens': '45000',
        'x-ratelimit-reset-tokens': '1m',
      });

      limiter.recordRateLimitResponse('p1', headers);

      const status = limiter.getStatus('p1');
      const tpm = status.find(w => w.type === 'tpm')!;
      expect(tpm.total).toBe(50_000);
      expect(tpm.remaining).toBe(45_000);
    });

    it('creates RPD window from -day suffixed headers', () => {
      const limiter = new RateLimiter({ now });

      const headers = new Headers({
        'x-ratelimit-limit-requests-day': '1000',
        'x-ratelimit-remaining-requests-day': '999',
      });

      limiter.recordRateLimitResponse('p1', headers);

      const status = limiter.getStatus('p1');
      const rpd = status.find(w => w.type === 'rpd');
      expect(rpd).toBeDefined();
      expect(rpd!.total).toBe(1000);
      expect(rpd!.remaining).toBe(999);
    });

    it('handles both request and token headers in same response', () => {
      const limiter = new RateLimiter({ now });

      const headers = new Headers({
        'x-ratelimit-limit-requests': '60',
        'x-ratelimit-remaining-requests': '55',
        'x-ratelimit-reset-requests': '1m',
        'x-ratelimit-limit-tokens': '40000',
        'x-ratelimit-remaining-tokens': '39500',
        'x-ratelimit-reset-tokens': '1m',
      });

      limiter.recordRateLimitResponse('p1', headers);

      const status = limiter.getStatus('p1');
      expect(status.length).toBeGreaterThanOrEqual(2);
      expect(status.find(w => w.type === 'rpm')).toBeDefined();
      expect(status.find(w => w.type === 'tpm')).toBeDefined();
    });

    it('overwrites existing windows with header values (authoritative)', () => {
      const limiter = new RateLimiter({ seedRpm: 10, now });

      // Seed creates RPM=10
      limiter.acquire('p1');
      let status = limiter.getStatus('p1');
      expect(status[0].total).toBe(10);

      // Header reports RPM=60
      const headers = new Headers({
        'x-ratelimit-limit-requests': '60',
        'x-ratelimit-remaining-requests': '59',
        'x-ratelimit-reset-requests': '1m',
      });
      limiter.recordRateLimitResponse('p1', headers);

      status = limiter.getStatus('p1');
      const rpm = status.find(w => w.type === 'rpm')!;
      expect(rpm.total).toBe(60);
      expect(rpm.remaining).toBe(59);
    });

    it('ignores malformed header values', () => {
      const limiter = new RateLimiter({ now });

      const headers = new Headers({
        'x-ratelimit-limit-requests': 'not-a-number',
      });

      limiter.recordRateLimitResponse('p1', headers);

      // Should still have the seed RPM, not crash
      const status = limiter.getStatus('p1');
      expect(status[0].type).toBe('rpm');
      expect(status[0].total).toBe(10);
    });
  });

  // ----------------------------------------------------------------
  // Real provider header formats
  // ----------------------------------------------------------------
  describe('real provider headers', () => {
    it('parses Groq headers (base format + duration resets)', () => {
      const limiter = new RateLimiter({ now });

      const headers = new Headers({
        'x-ratelimit-limit-requests': '14400',
        'x-ratelimit-remaining-requests': '14399',
        'x-ratelimit-reset-requests': '6s',
        'x-ratelimit-limit-tokens': '6000',
        'x-ratelimit-remaining-tokens': '5956',
        'x-ratelimit-reset-tokens': '440ms',
      });

      limiter.recordRateLimitResponse('groq', headers);

      const status = limiter.getStatus('groq');
      const rpm = status.find(w => w.type === 'rpm')!;
      const tpm = status.find(w => w.type === 'tpm')!;

      expect(rpm.total).toBe(14400);
      expect(rpm.remaining).toBe(14399);
      expect(rpm.resetsAt.getTime()).toBe(clock + 6_000);

      expect(tpm.total).toBe(6000);
      expect(tpm.remaining).toBe(5956);
      expect(tpm.resetsAt.getTime()).toBe(clock + 440);
    });

    it('parses Cerebras headers (suffixed -minute and -day)', () => {
      const limiter = new RateLimiter({ now });

      const headers = new Headers({
        'x-ratelimit-limit-requests-minute': '30',
        'x-ratelimit-remaining-requests-minute': '29',
        'x-ratelimit-limit-requests-day': '14400',
        'x-ratelimit-remaining-requests-day': '14399',
        'x-ratelimit-limit-tokens-minute': '60000',
        'x-ratelimit-remaining-tokens-minute': '59963',
        'x-ratelimit-limit-tokens-day': '1000000',
        'x-ratelimit-remaining-tokens-day': '999963',
      });

      limiter.recordRateLimitResponse('cerebras', headers);

      const status = limiter.getStatus('cerebras');
      const rpm = status.find(w => w.type === 'rpm')!;
      const rpd = status.find(w => w.type === 'rpd')!;
      const tpm = status.find(w => w.type === 'tpm')!;

      expect(rpm.total).toBe(30);
      expect(rpm.remaining).toBe(29);

      expect(rpd.total).toBe(14400);
      expect(rpd.remaining).toBe(14399);

      expect(tpm.total).toBe(60000);
      expect(tpm.remaining).toBe(59963);
    });

    it('parses SambaNova headers (RPD only + unix timestamp reset)', () => {
      // SambaNova reset is a unix timestamp in seconds
      // Use a realistic clock so the timestamp exceeds 1 billion
      clock = 1_771_716_000_000; // ~Feb 2026 in ms
      const resetTimestamp = Math.floor(clock / 1000) + 86400; // 1 day from now
      const limiter = new RateLimiter({ now });

      const headers = new Headers({
        'x-ratelimit-limit-requests-day': '20',
        'x-ratelimit-remaining-requests-day': '18',
        'x-ratelimit-reset-requests-day': String(resetTimestamp),
      });

      limiter.recordRateLimitResponse('sambanova', headers);

      const status = limiter.getStatus('sambanova');
      const rpd = status.find(w => w.type === 'rpd')!;

      expect(rpd.total).toBe(20);
      expect(rpd.remaining).toBe(18);
      // Reset should be ~86400s from now
      const expectedResetMs = resetTimestamp * 1000 - clock;
      expect(rpd.resetsAt.getTime()).toBe(clock + expectedResetMs);
    });

    it('parses GitHub Models headers (base format, no reset)', () => {
      const limiter = new RateLimiter({ now });

      const headers = new Headers({
        'x-ratelimit-limit-requests': '20000',
        'x-ratelimit-remaining-requests': '19998',
        'x-ratelimit-limit-tokens': '2000000',
        'x-ratelimit-remaining-tokens': '1996574',
      });

      limiter.recordRateLimitResponse('github', headers);

      const status = limiter.getStatus('github');
      const rpm = status.find(w => w.type === 'rpm')!;
      const tpm = status.find(w => w.type === 'tpm')!;

      expect(rpm.total).toBe(20000);
      expect(rpm.remaining).toBe(19998);
      // No reset header → defaults to 60s window
      expect(rpm.resetsAt.getTime()).toBe(clock + 60_000);

      expect(tpm.total).toBe(2000000);
      expect(tpm.remaining).toBe(1996574);
    });

    it('creates both RPM and RPD when base and -day headers coexist', () => {
      // Hypothetical provider with both formats
      const limiter = new RateLimiter({ now });

      const headers = new Headers({
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '99',
        'x-ratelimit-limit-requests-day': '5000',
        'x-ratelimit-remaining-requests-day': '4999',
      });

      limiter.recordRateLimitResponse('mixed', headers);

      const status = limiter.getStatus('mixed');
      const rpm = status.find(w => w.type === 'rpm');
      const rpd = status.find(w => w.type === 'rpd');

      expect(rpm).toBeDefined();
      expect(rpm!.total).toBe(100);
      expect(rpd).toBeDefined();
      expect(rpd!.total).toBe(5000);
    });
  });

  // ----------------------------------------------------------------
  // Duration parsing (tested via recordRateLimitResponse)
  // ----------------------------------------------------------------
  describe('duration parsing', () => {
    it('parses seconds (6s)', () => {
      const limiter = new RateLimiter({ now });
      const headers = new Headers({
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '50',
        'x-ratelimit-reset-requests': '6s',
      });
      limiter.recordRateLimitResponse('p1', headers);

      const rpm = limiter.getStatus('p1').find(w => w.type === 'rpm')!;
      // resetsAt should be clock + 6000ms
      expect(rpm.resetsAt.getTime()).toBe(clock + 6_000);
    });

    it('parses minutes (1m)', () => {
      const limiter = new RateLimiter({ now });
      const headers = new Headers({
        'x-ratelimit-limit-tokens': '10000',
        'x-ratelimit-reset-tokens': '1m',
      });
      limiter.recordRateLimitResponse('p1', headers);

      const tpm = limiter.getStatus('p1').find(w => w.type === 'tpm')!;
      expect(tpm.resetsAt.getTime()).toBe(clock + 60_000);
    });

    it('parses combined duration (1m30s)', () => {
      const limiter = new RateLimiter({ now });
      const headers = new Headers({
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '99',
        'x-ratelimit-reset-requests': '1m30s',
      });
      limiter.recordRateLimitResponse('p1', headers);

      const rpm = limiter.getStatus('p1').find(w => w.type === 'rpm')!;
      expect(rpm.resetsAt.getTime()).toBe(clock + 90_000);
    });

    it('parses milliseconds (500ms)', () => {
      const limiter = new RateLimiter({ now });
      const headers = new Headers({
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '99',
        'x-ratelimit-reset-requests': '500ms',
      });
      limiter.recordRateLimitResponse('p1', headers);

      const rpm = limiter.getStatus('p1').find(w => w.type === 'rpm')!;
      expect(rpm.resetsAt.getTime()).toBe(clock + 500);
    });

    it('parses plain number as seconds', () => {
      const limiter = new RateLimiter({ now });
      const headers = new Headers({
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '99',
        'x-ratelimit-reset-requests': '60',
      });
      limiter.recordRateLimitResponse('p1', headers);

      const rpm = limiter.getStatus('p1').find(w => w.type === 'rpm')!;
      expect(rpm.resetsAt.getTime()).toBe(clock + 60_000);
    });
  });

  // ----------------------------------------------------------------
  // reconcile() — token correction
  // ----------------------------------------------------------------
  describe('reconcile', () => {
    it('gives back unused tokens when actual < estimated', () => {
      const limiter = new RateLimiter({
        now,
        providerOverrides: {
          p1: [{ type: 'tpm', total: 1000, windowMs: 60_000 }],
        },
      });

      limiter.acquire('p1', 500); // estimated 500
      let status = limiter.getStatus('p1');
      expect(status[0].remaining).toBe(500);

      limiter.reconcile('p1', 500, 300); // estimated 500, actual 300
      status = limiter.getStatus('p1');
      expect(status[0].remaining).toBe(700); // gave back 200
    });

    it('consumes extra tokens when actual > estimated', () => {
      const limiter = new RateLimiter({
        now,
        providerOverrides: {
          p1: [{ type: 'tpm', total: 1000, windowMs: 60_000 }],
        },
      });

      limiter.acquire('p1', 300);
      limiter.reconcile('p1', 300, 500); // estimated 300, actual 500

      const status = limiter.getStatus('p1');
      expect(status[0].remaining).toBe(500); // 1000 - 300 - 200 = 500
    });

    it('clamps remaining to total', () => {
      const limiter = new RateLimiter({
        now,
        providerOverrides: {
          p1: [{ type: 'tpm', total: 1000, windowMs: 60_000 }],
        },
      });

      limiter.acquire('p1', 500);
      limiter.reconcile('p1', 500, 0); // estimated 500, actual 0 → give back 500 (capped at total)

      const status = limiter.getStatus('p1');
      expect(status[0].remaining).toBe(1000);
    });

    it('does nothing when actualTokens is undefined', () => {
      const limiter = new RateLimiter({
        now,
        providerOverrides: {
          p1: [{ type: 'tpm', total: 1000, windowMs: 60_000 }],
        },
      });

      limiter.acquire('p1', 400);
      limiter.reconcile('p1', 400, undefined);

      const status = limiter.getStatus('p1');
      expect(status[0].remaining).toBe(600); // unchanged
    });

    it('is a no-op for unknown providers', () => {
      const limiter = new RateLimiter({ now });
      // Should not throw
      limiter.reconcile('unknown', 0, 100);
    });

    it('is a no-op when no TPM window exists', () => {
      const limiter = new RateLimiter({ seedRpm: 10, now });
      limiter.acquire('p1');
      // Should not throw — only RPM window exists
      limiter.reconcile('p1', 0, 100);
    });
  });

  // ----------------------------------------------------------------
  // getStatus returns snapshots
  // ----------------------------------------------------------------
  describe('getStatus', () => {
    it('returns seed windows for providers without prior requests', () => {
      const limiter = new RateLimiter({ now });
      const status = limiter.getStatus('unknown');
      expect(status).toHaveLength(1);
      expect(status[0].type).toBe('rpm');
      expect(status[0].total).toBe(10);
      expect(status[0].remaining).toBe(10);
    });

    it('returns a defensive copy of resetsAt', () => {
      const limiter = new RateLimiter({ now });
      limiter.acquire('p1');

      const status = limiter.getStatus('p1');
      const originalTime = status[0].resetsAt.getTime();

      // Mutating the returned Date should not affect internal state
      status[0].resetsAt.setTime(0);

      const status2 = limiter.getStatus('p1');
      expect(status2[0].resetsAt.getTime()).toBe(originalTime);
    });
  });
});
