import { describe, it, expect, vi } from 'vitest';
import { RequestLog } from '../../dashboard/request-log.js';
import type { RouteCompleteEvent } from '../../dashboard/types.js';

function makeEvent(overrides?: Partial<RouteCompleteEvent>): RouteCompleteEvent {
  return {
    model: 'llama-3.1-8b-instant',
    steps: [{ provider: 'groq', action: 'succeeded' }],
    outcome: 'success',
    latencyMs: 100,
    provider: 'groq',
    ...overrides,
  };
}

describe('RequestLog', () => {
  it('records entries and returns them newest-first', () => {
    const log = new RequestLog(100);

    log.record(makeEvent({ latencyMs: 10 }));
    log.record(makeEvent({ latencyMs: 20 }));
    log.record(makeEvent({ latencyMs: 30 }));

    const recent = log.getRecent();
    expect(recent).toHaveLength(3);
    expect(recent[0].latencyMs).toBe(30);
    expect(recent[1].latencyMs).toBe(20);
    expect(recent[2].latencyMs).toBe(10);
  });

  it('assigns incrementing string IDs', () => {
    const log = new RequestLog(100);

    const e1 = log.record(makeEvent());
    const e2 = log.record(makeEvent());
    const e3 = log.record(makeEvent());

    expect(e1.id).toBe('1');
    expect(e2.id).toBe('2');
    expect(e3.id).toBe('3');
  });

  it('wraps around at capacity', () => {
    const log = new RequestLog(3);

    log.record(makeEvent({ latencyMs: 1 }));
    log.record(makeEvent({ latencyMs: 2 }));
    log.record(makeEvent({ latencyMs: 3 }));
    log.record(makeEvent({ latencyMs: 4 })); // overwrites first

    expect(log.size).toBe(3);
    const recent = log.getRecent();
    expect(recent).toHaveLength(3);
    expect(recent[0].latencyMs).toBe(4);
    expect(recent[1].latencyMs).toBe(3);
    expect(recent[2].latencyMs).toBe(2);
  });

  it('getRecent respects limit parameter', () => {
    const log = new RequestLog(100);

    for (let i = 0; i < 10; i++) {
      log.record(makeEvent({ latencyMs: i }));
    }

    const recent = log.getRecent(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].latencyMs).toBe(9);
    expect(recent[1].latencyMs).toBe(8);
    expect(recent[2].latencyMs).toBe(7);
  });

  it('tracks totalRecorded across wraps', () => {
    const log = new RequestLog(2);

    log.record(makeEvent());
    log.record(makeEvent());
    log.record(makeEvent());
    log.record(makeEvent());

    expect(log.size).toBe(2);
    expect(log.totalRecorded).toBe(4);
  });

  it('notifies listeners on new entries', () => {
    const log = new RequestLog(100);
    const listener = vi.fn();

    log.onEntry(listener);
    const entry = log.record(makeEvent());

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(entry);
  });

  it('unsubscribe stops notifications', () => {
    const log = new RequestLog(100);
    const listener = vi.fn();

    const unsubscribe = log.onEntry(listener);
    log.record(makeEvent());
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    log.record(makeEvent());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('populates entry fields from RouteCompleteEvent', () => {
    const log = new RequestLog(100);

    const entry = log.record({
      model: 'gpt-4o-mini',
      steps: [
        { provider: 'groq', action: 'skipped-rate-limited', reason: 'wait 5000ms' },
        { provider: 'cerebras', action: 'succeeded' },
      ],
      outcome: 'fallback-success',
      latencyMs: 380,
      provider: 'cerebras',
    });

    expect(entry.model).toBe('gpt-4o-mini');
    expect(entry.routingChain).toHaveLength(2);
    expect(entry.routingChain[0].action).toBe('skipped-rate-limited');
    expect(entry.routingChain[1].action).toBe('succeeded');
    expect(entry.outcome).toBe('fallback-success');
    expect(entry.provider).toBe('cerebras');
    expect(entry.timestamp).toBeGreaterThan(0);
  });

  it('returns empty array when no entries', () => {
    const log = new RequestLog(100);
    expect(log.getRecent()).toEqual([]);
    expect(log.size).toBe(0);
    expect(log.totalRecorded).toBe(0);
  });
});
