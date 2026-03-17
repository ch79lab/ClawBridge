import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  recordOutcome,
  computeModelHealth,
  reorderFallbackChain,
  getHealthStatus,
  getModelHealthScore,
  resetHealth,
} from '../src/health.js';
import type { FallbackStep, Upstream } from '../src/types.js';

// Mock logger
vi.mock('../src/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  resetHealth();
});

describe('recordOutcome + computeModelHealth', () => {
  it('returns neutral score with no data', () => {
    const h = computeModelHealth('claude-sonnet-4-5', 'anthropic');
    expect(h.window_size).toBe(0);
    expect(h.health_score).toBe(0.5);
    expect(h.success_rate).toBe(1);
  });

  it('returns neutral score with fewer than MIN_SAMPLES', () => {
    recordOutcome('claude-haiku-4-5', 'anthropic', true, 100);
    recordOutcome('claude-haiku-4-5', 'anthropic', true, 200);
    const h = computeModelHealth('claude-haiku-4-5', 'anthropic');
    expect(h.window_size).toBe(2);
    expect(h.health_score).toBe(0.5); // Not enough samples
  });

  it('computes high score for all-success fast model', () => {
    for (let i = 0; i < 10; i++) {
      recordOutcome('claude-haiku-4-5', 'anthropic', true, 500);
    }
    const h = computeModelHealth('claude-haiku-4-5', 'anthropic');
    expect(h.window_size).toBe(10);
    expect(h.success_count).toBe(10);
    expect(h.failure_count).toBe(0);
    expect(h.success_rate).toBe(1);
    expect(h.health_score).toBeGreaterThan(0.9);
  });

  it('computes low score for high failure rate', () => {
    for (let i = 0; i < 8; i++) {
      recordOutcome('gemini-2.5-flash', 'google', false, 0, 'timeout');
    }
    for (let i = 0; i < 2; i++) {
      recordOutcome('gemini-2.5-flash', 'google', true, 1000);
    }
    const h = computeModelHealth('gemini-2.5-flash', 'google');
    expect(h.success_rate).toBeLessThan(0.3);
    expect(h.health_score).toBeLessThan(0.5);
    expect(h.last_error).toBe('timeout');
  });

  it('penalizes high latency', () => {
    // Fast model
    for (let i = 0; i < 5; i++) {
      recordOutcome('fast-model', 'anthropic', true, 200);
    }
    // Slow model
    for (let i = 0; i < 5; i++) {
      recordOutcome('slow-model', 'anthropic', true, 25000);
    }

    const fast = computeModelHealth('fast-model', 'anthropic');
    const slow = computeModelHealth('slow-model', 'anthropic');

    expect(fast.health_score).toBeGreaterThan(slow.health_score);
    expect(fast.latency_p95).toBeLessThan(slow.latency_p95);
  });

  it('respects sliding window size', () => {
    // Record 60 outcomes (window = 50)
    for (let i = 0; i < 60; i++) {
      recordOutcome('claude-haiku-4-5', 'anthropic', true, 100);
    }
    const h = computeModelHealth('claude-haiku-4-5', 'anthropic');
    expect(h.window_size).toBe(50);
  });

  it('computes latency percentiles correctly', () => {
    const latencies = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    for (const l of latencies) {
      recordOutcome('test-model', 'anthropic', true, l);
    }
    const h = computeModelHealth('test-model', 'anthropic');
    expect(h.latency_p50).toBe(600);  // index 5
    expect(h.latency_p95).toBe(1000); // index 9
    expect(h.latency_avg).toBe(550);
  });
});

describe('reorderFallbackChain', () => {
  const chain: FallbackStep[] = [
    { model: 'gemini-2.5-flash', upstream: 'google' as Upstream, timeoutMs: 45000 },
    { model: 'claude-haiku-4-5', upstream: 'anthropic' as Upstream, timeoutMs: 30000 },
    { model: 'claude-sonnet-4-5', upstream: 'anthropic' as Upstream, timeoutMs: 60000 },
  ];

  it('does not reorder with no data', () => {
    const { reordered, wasReordered } = reorderFallbackChain(chain);
    expect(wasReordered).toBe(false);
    expect(reordered).toEqual(chain);
  });

  it('does not reorder with insufficient data', () => {
    recordOutcome('gemini-2.5-flash', 'google', true, 100);
    recordOutcome('claude-haiku-4-5', 'anthropic', true, 100);
    const { wasReordered } = reorderFallbackChain(chain);
    expect(wasReordered).toBe(false);
  });

  it('promotes healthier model to front of chain', () => {
    // Make haiku very healthy
    for (let i = 0; i < 10; i++) {
      recordOutcome('claude-haiku-4-5', 'anthropic', true, 200);
    }
    // Make gemini-flash unhealthy
    for (let i = 0; i < 10; i++) {
      recordOutcome('gemini-2.5-flash', 'google', false, 0, 'error');
    }

    const { reordered, wasReordered } = reorderFallbackChain(chain);
    expect(wasReordered).toBe(true);
    expect(reordered[0].model).toBe('claude-haiku-4-5');
  });

  it('preserves order when all models equally healthy', () => {
    for (const step of chain) {
      for (let i = 0; i < 5; i++) {
        recordOutcome(step.model, step.upstream, true, 500);
      }
    }
    const { reordered, wasReordered } = reorderFallbackChain(chain);
    // All have same score → stable sort, no reorder
    expect(wasReordered).toBe(false);
  });

  it('handles single-element chain', () => {
    const single: FallbackStep[] = [{ model: 'test', upstream: 'anthropic', timeoutMs: 1000 }];
    const { reordered, wasReordered } = reorderFallbackChain(single);
    expect(wasReordered).toBe(false);
    expect(reordered).toEqual(single);
  });
});

describe('getHealthStatus', () => {
  it('includes all tracked models', () => {
    recordOutcome('claude-haiku-4-5', 'anthropic', true, 100);
    recordOutcome('gemini-2.5-flash', 'google', true, 200);

    const chain: FallbackStep[] = [
      { model: 'gemini-2.5-flash', upstream: 'google' as Upstream, timeoutMs: 45000 },
      { model: 'claude-haiku-4-5', upstream: 'anthropic' as Upstream, timeoutMs: 30000 },
    ];

    const status = getHealthStatus(chain);
    expect(status.models.length).toBe(2);
    expect(status.fallback_order.length).toBe(2);
  });

  it('includes untracked chain models', () => {
    const chain: FallbackStep[] = [
      { model: 'gemini-2.5-flash', upstream: 'google' as Upstream, timeoutMs: 45000 },
      { model: 'claude-sonnet-4-5', upstream: 'anthropic' as Upstream, timeoutMs: 60000 },
    ];
    const status = getHealthStatus(chain);
    // Both should appear even with no data
    expect(status.models.length).toBe(2);
  });
});

describe('getModelHealthScore', () => {
  it('returns neutral for unknown model', () => {
    expect(getModelHealthScore('unknown', 'anthropic')).toBe(0.5);
  });

  it('returns computed score for tracked model', () => {
    for (let i = 0; i < 5; i++) {
      recordOutcome('claude-haiku-4-5', 'anthropic', true, 300);
    }
    const score = getModelHealthScore('claude-haiku-4-5', 'anthropic');
    expect(score).toBeGreaterThan(0.5);
  });
});
