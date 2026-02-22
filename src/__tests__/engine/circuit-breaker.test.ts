import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker, type StateChangeCallback } from '../../engine/circuit-breaker.js';

describe('CircuitBreaker', () => {
  const defaultConfig = {
    failureThreshold: 3,
    cooldownMs: 1000,
    maxCooldownMs: 16000,
  };

  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    breaker = new CircuitBreaker(defaultConfig);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('unknown provider', () => {
    it('starts in closed state', () => {
      expect(breaker.getState('unknown-provider')).toBe('closed');
    });

    it('allows requests through (tryProbe returns true)', () => {
      expect(breaker.tryProbe('never-seen')).toBe(true);
    });
  });

  describe('closed state', () => {
    it('always grants admission', () => {
      for (let i = 0; i < 10; i++) {
        expect(breaker.tryProbe('provider-a')).toBe(true);
      }
      expect(breaker.getState('provider-a')).toBe('closed');
    });
  });

  describe('closed -> open transition', () => {
    it('trips open after reaching the failure threshold', () => {
      breaker.recordFailure('provider-a');
      breaker.recordFailure('provider-a');
      expect(breaker.getState('provider-a')).toBe('closed');

      breaker.recordFailure('provider-a');
      expect(breaker.getState('provider-a')).toBe('open');
    });

    it('rejects requests when open and cooldown has not expired', () => {
      tripOpen('provider-a');

      expect(breaker.tryProbe('provider-a')).toBe(false);
      vi.advanceTimersByTime(defaultConfig.cooldownMs - 1);
      expect(breaker.tryProbe('provider-a')).toBe(false);
    });
  });

  describe('cooldown expiry -> half-open', () => {
    it('transitions to half-open when cooldown expires and tryProbe is called', () => {
      tripOpen('provider-a');

      vi.advanceTimersByTime(defaultConfig.cooldownMs);
      const granted = breaker.tryProbe('provider-a');

      expect(granted).toBe(true);
      expect(breaker.getState('provider-a')).toBe('half-open');
    });
  });

  describe('tryProbe atomicity in half-open', () => {
    it('grants exactly one caller when multiple call tryProbe concurrently', () => {
      tripOpen('provider-a');
      vi.advanceTimersByTime(defaultConfig.cooldownMs);

      // Simulate concurrent callers -- all synchronous, one after another
      const results = [
        breaker.tryProbe('provider-a'),
        breaker.tryProbe('provider-a'),
        breaker.tryProbe('provider-a'),
        breaker.tryProbe('provider-a'),
        breaker.tryProbe('provider-a'),
      ];

      const granted = results.filter(Boolean);
      expect(granted).toHaveLength(1);
      expect(results[0]).toBe(true);
      expect(breaker.getState('provider-a')).toBe('half-open');
    });

    it('grants a second probe after the first completes successfully', () => {
      tripOpen('provider-a');
      vi.advanceTimersByTime(defaultConfig.cooldownMs);

      expect(breaker.tryProbe('provider-a')).toBe(true);
      expect(breaker.tryProbe('provider-a')).toBe(false);

      // First probe succeeds -- circuit closes
      breaker.recordSuccess('provider-a');
      expect(breaker.getState('provider-a')).toBe('closed');

      // Now requests flow freely again
      expect(breaker.tryProbe('provider-a')).toBe(true);
    });
  });

  describe('successful probe closes circuit', () => {
    it('resets to closed state and clears failure count', () => {
      tripOpen('provider-a');
      vi.advanceTimersByTime(defaultConfig.cooldownMs);

      breaker.tryProbe('provider-a');
      breaker.recordSuccess('provider-a');

      expect(breaker.getState('provider-a')).toBe('closed');
      // Verify the failure count was reset by checking we need the full
      // threshold again to trip open
      breaker.recordFailure('provider-a');
      breaker.recordFailure('provider-a');
      expect(breaker.getState('provider-a')).toBe('closed');
      breaker.recordFailure('provider-a');
      expect(breaker.getState('provider-a')).toBe('open');
    });
  });

  describe('failed probe re-opens with extended cooldown', () => {
    it('doubles the cooldown on half-open failure', () => {
      tripOpen('provider-a');

      // First cooldown: 1000ms
      vi.advanceTimersByTime(defaultConfig.cooldownMs);
      breaker.tryProbe('provider-a');
      breaker.recordFailure('provider-a');
      expect(breaker.getState('provider-a')).toBe('open');

      // Second cooldown should be 2000ms
      vi.advanceTimersByTime(1999);
      expect(breaker.tryProbe('provider-a')).toBe(false);

      vi.advanceTimersByTime(1);
      expect(breaker.tryProbe('provider-a')).toBe(true);
      expect(breaker.getState('provider-a')).toBe('half-open');
    });

    it('keeps doubling on repeated half-open failures', () => {
      tripOpen('provider-a');

      // 1st backoff: 1000ms -> fail -> 2000ms
      vi.advanceTimersByTime(1000);
      breaker.tryProbe('provider-a');
      breaker.recordFailure('provider-a');

      // 2nd backoff: 2000ms -> fail -> 4000ms
      vi.advanceTimersByTime(2000);
      breaker.tryProbe('provider-a');
      breaker.recordFailure('provider-a');

      // 3rd backoff: 4000ms -> fail -> 8000ms
      vi.advanceTimersByTime(4000);
      breaker.tryProbe('provider-a');
      breaker.recordFailure('provider-a');

      // Verify we need 8000ms now
      vi.advanceTimersByTime(7999);
      expect(breaker.tryProbe('provider-a')).toBe(false);

      vi.advanceTimersByTime(1);
      expect(breaker.tryProbe('provider-a')).toBe(true);
    });
  });

  describe('maxCooldownMs caps backoff', () => {
    it('does not exceed the maximum cooldown', () => {
      const shortCap = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 1000,
        maxCooldownMs: 3000,
      });

      // Trip open
      shortCap.recordFailure('p1');
      expect(shortCap.getState('p1')).toBe('open');

      // 1st backoff: 1000ms -> fail -> 2000ms
      vi.advanceTimersByTime(1000);
      shortCap.tryProbe('p1');
      shortCap.recordFailure('p1');

      // 2nd backoff: 2000ms -> fail -> would be 4000, capped to 3000
      vi.advanceTimersByTime(2000);
      shortCap.tryProbe('p1');
      shortCap.recordFailure('p1');

      // 3rd backoff: should be 3000 (capped), not 4000
      vi.advanceTimersByTime(2999);
      expect(shortCap.tryProbe('p1')).toBe(false);

      vi.advanceTimersByTime(1);
      expect(shortCap.tryProbe('p1')).toBe(true);
      expect(shortCap.getState('p1')).toBe('half-open');
    });

    it('stays at the cap on further failures', () => {
      const shortCap = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 1000,
        maxCooldownMs: 2000,
      });

      // Trip open
      shortCap.recordFailure('p1');

      // 1st backoff: 1000 -> fail -> 2000
      vi.advanceTimersByTime(1000);
      shortCap.tryProbe('p1');
      shortCap.recordFailure('p1');

      // 2nd backoff: 2000 (capped) -> fail -> still 2000
      vi.advanceTimersByTime(2000);
      shortCap.tryProbe('p1');
      shortCap.recordFailure('p1');

      // 3rd backoff: still 2000
      vi.advanceTimersByTime(2000);
      expect(shortCap.tryProbe('p1')).toBe(true);
    });
  });

  describe('onStateChange', () => {
    it('fires callback on closed -> open', () => {
      const listener = vi.fn<StateChangeCallback>();
      breaker.onStateChange(listener);

      tripOpen('provider-a');

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith('provider-a', 'closed', 'open');
    });

    it('fires callback on open -> half-open', () => {
      const listener = vi.fn<StateChangeCallback>();
      breaker.onStateChange(listener);

      tripOpen('provider-a');
      vi.advanceTimersByTime(defaultConfig.cooldownMs);
      breaker.tryProbe('provider-a');

      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenNthCalledWith(2, 'provider-a', 'open', 'half-open');
    });

    it('fires callback on half-open -> closed (success)', () => {
      const listener = vi.fn<StateChangeCallback>();
      breaker.onStateChange(listener);

      tripOpen('provider-a');
      vi.advanceTimersByTime(defaultConfig.cooldownMs);
      breaker.tryProbe('provider-a');
      breaker.recordSuccess('provider-a');

      expect(listener).toHaveBeenCalledTimes(3);
      expect(listener).toHaveBeenNthCalledWith(3, 'provider-a', 'half-open', 'closed');
    });

    it('fires callback on half-open -> open (failure)', () => {
      const listener = vi.fn<StateChangeCallback>();
      breaker.onStateChange(listener);

      tripOpen('provider-a');
      vi.advanceTimersByTime(defaultConfig.cooldownMs);
      breaker.tryProbe('provider-a');
      breaker.recordFailure('provider-a');

      expect(listener).toHaveBeenCalledTimes(3);
      expect(listener).toHaveBeenNthCalledWith(3, 'provider-a', 'half-open', 'open');
    });

    it('supports multiple listeners', () => {
      const listener1 = vi.fn<StateChangeCallback>();
      const listener2 = vi.fn<StateChangeCallback>();
      breaker.onStateChange(listener1);
      breaker.onStateChange(listener2);

      tripOpen('provider-a');

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
    });

    it('does not fire when recordSuccess is called on already-closed circuit', () => {
      const listener = vi.fn<StateChangeCallback>();
      breaker.onStateChange(listener);

      breaker.recordSuccess('provider-a');

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('provider isolation', () => {
    it('tracks state independently per provider', () => {
      tripOpen('provider-a');

      expect(breaker.getState('provider-a')).toBe('open');
      expect(breaker.getState('provider-b')).toBe('closed');
      expect(breaker.tryProbe('provider-b')).toBe(true);
    });
  });

  // Helper: push a provider through the failure threshold into the open state
  function tripOpen(providerId: string): void {
    for (let i = 0; i < defaultConfig.failureThreshold; i++) {
      breaker.recordFailure(providerId);
    }
  }
});
