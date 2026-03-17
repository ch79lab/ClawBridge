// ═══════════════════════════════════════════════════════════
// ClawBridge — SLO-Aware Health Tracker
// ═══════════════════════════════════════════════════════════
//
// In-memory sliding window per model/upstream.
// Records success/failure + latency on each request completion.
// Computes health_score for dynamic fallback reordering.

import { log } from './logger.js';
import type { FallbackStep, ModelHealth, HealthStatus, Upstream } from './types.js';

// ── Config ───────────────────────────────────────────────

const WINDOW_SIZE = 50;         // Last N outcomes per model
const LATENCY_CEILING_MS = 30000; // Latency above this = max penalty
const MIN_SAMPLES = 3;          // Need at least N samples to affect score
const DECAY_HOURS = 24;         // Samples older than this get discounted

// ── Per-model outcome buffer ─────────────────────────────

interface Outcome {
  ts: number;       // Date.now()
  ok: boolean;
  latencyMs: number;
  error?: string;
}

const buffers = new Map<string, Outcome[]>();

function key(model: string, upstream: string): string {
  return `${upstream}/${model}`;
}

function getBuffer(model: string, upstream: string): Outcome[] {
  const k = key(model, upstream);
  if (!buffers.has(k)) buffers.set(k, []);
  return buffers.get(k)!;
}

// ── Record outcome ───────────────────────────────────────

export function recordOutcome(
  model: string,
  upstream: string,
  ok: boolean,
  latencyMs: number,
  error?: string,
): void {
  const buf = getBuffer(model, upstream);
  buf.push({ ts: Date.now(), ok, latencyMs, error });

  // Keep sliding window
  if (buf.length > WINDOW_SIZE) {
    buf.splice(0, buf.length - WINDOW_SIZE);
  }
}

// ── Compute health score for one model ───────────────────

export function computeModelHealth(model: string, upstream: Upstream): ModelHealth {
  const buf = getBuffer(model, upstream);
  const now = Date.now();

  if (buf.length === 0) {
    return {
      model,
      upstream,
      window_size: 0,
      success_count: 0,
      failure_count: 0,
      success_rate: 1,      // Assume healthy if no data
      latency_p50: 0,
      latency_p95: 0,
      latency_avg: 0,
      health_score: 0.5,    // Neutral score with no data
    };
  }

  // Weight recent samples more heavily
  const decayMs = DECAY_HOURS * 3600 * 1000;

  let weightedSuccess = 0;
  let weightedTotal = 0;
  const latencies: number[] = [];

  for (const o of buf) {
    const age = now - o.ts;
    const weight = age < decayMs ? 1 : 0.5; // Old samples get half weight

    weightedTotal += weight;
    if (o.ok) {
      weightedSuccess += weight;
      latencies.push(o.latencyMs);
    }
  }

  const successRate = weightedTotal > 0 ? weightedSuccess / weightedTotal : 1;
  const successCount = buf.filter(o => o.ok).length;
  const failureCount = buf.length - successCount;

  // Latency percentiles (from successful requests only)
  latencies.sort((a, b) => a - b);
  const p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.5)] : 0;
  const p95 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : 0;
  const avg = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

  // Latency penalty: 0 = fast, 1 = at ceiling
  const latencyPenalty = p95 > 0 ? Math.min(p95 / LATENCY_CEILING_MS, 1) : 0;

  // Composite health score: success rate weighted 70%, latency 30%
  const healthScore = buf.length >= MIN_SAMPLES
    ? (successRate * 0.7) + ((1 - latencyPenalty) * 0.3)
    : 0.5; // Not enough data → neutral

  // Find last success/failure
  const lastSuccess = [...buf].reverse().find(o => o.ok);
  const lastFailure = [...buf].reverse().find(o => !o.ok);

  return {
    model,
    upstream,
    window_size: buf.length,
    success_count: successCount,
    failure_count: failureCount,
    success_rate: round3(successRate),
    latency_p50: Math.round(p50),
    latency_p95: Math.round(p95),
    latency_avg: Math.round(avg),
    health_score: round3(healthScore),
    last_success_ts: lastSuccess ? new Date(lastSuccess.ts).toISOString() : undefined,
    last_failure_ts: lastFailure ? new Date(lastFailure.ts).toISOString() : undefined,
    last_error: lastFailure?.error,
  };
}

// ── Get health for all tracked models ────────────────────

export function getHealthStatus(fallbackChain: FallbackStep[]): HealthStatus {
  // Collect all known models (from buffers + fallback chain)
  const seen = new Set<string>();
  const models: ModelHealth[] = [];

  for (const [k] of buffers) {
    if (seen.has(k)) continue;
    seen.add(k);
    const [upstream, ...modelParts] = k.split('/');
    const model = modelParts.join('/');
    models.push(computeModelHealth(model, upstream as Upstream));
  }

  // Add chain models not yet tracked
  for (const step of fallbackChain) {
    const k = key(step.model, step.upstream);
    if (!seen.has(k)) {
      seen.add(k);
      models.push(computeModelHealth(step.model, step.upstream));
    }
  }

  // Sort by health score descending
  models.sort((a, b) => b.health_score - a.health_score);

  const fallback_order = models.map(m => ({
    model: m.model,
    upstream: m.upstream,
    health_score: m.health_score,
  }));

  return { models, fallback_order };
}

// ── Reorder fallback chain by health ─────────────────────

export function reorderFallbackChain(
  chain: FallbackStep[],
): { reordered: FallbackStep[]; wasReordered: boolean } {
  if (chain.length <= 1) {
    return { reordered: chain, wasReordered: false };
  }

  // Compute health for each step
  const scored = chain.map(step => ({
    step,
    health: computeModelHealth(step.model, step.upstream),
  }));

  // Only reorder if we have enough data for at least one model
  const hasData = scored.some(s => s.health.window_size >= MIN_SAMPLES);
  if (!hasData) {
    return { reordered: chain, wasReordered: false };
  }

  // Sort by health score descending (healthiest first)
  const sorted = [...scored].sort((a, b) => b.health.health_score - a.health.health_score);

  // Check if order actually changed
  const wasReordered = sorted.some((s, i) => s.step !== scored[i].step);

  if (wasReordered) {
    log.info({
      msg: 'fallback_reordered',
      original: chain.map(s => `${s.upstream}/${s.model}`),
      reordered: sorted.map(s => `${s.step.upstream}/${s.step.model}`),
      scores: sorted.map(s => ({ model: s.step.model, score: s.health.health_score })),
    });
  }

  return {
    reordered: sorted.map(s => s.step),
    wasReordered,
  };
}

// ── Get health score for a specific model ────────────────

export function getModelHealthScore(model: string, upstream: Upstream): number {
  return computeModelHealth(model, upstream).health_score;
}

// ── Reset (for testing) ──────────────────────────────────

export function resetHealth(): void {
  buffers.clear();
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
