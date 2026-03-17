// ═══════════════════════════════════════════════════════════
// ClawBridge — Usage Tracking
// ═══════════════════════════════════════════════════════════

import { appendFile } from 'node:fs/promises';
import { mkdirSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pricingConfig } from './config.js';
import { log } from './logger.js';
import type { UsageRecord } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const USAGE_FILE = join(DATA_DIR, 'usage.jsonl');

// Ensure data directory exists
mkdirSync(DATA_DIR, { recursive: true });

// ── Token extraction ────────────────────────────────────────

export function extractTokensFromBody(body: string | undefined): {
  input_tokens: number;
  output_tokens: number;
} {
  if (!body) return { input_tokens: 0, output_tokens: 0 };
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const usage = parsed.usage as Record<string, number> | undefined;
    return {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
    };
  } catch {
    return { input_tokens: 0, output_tokens: 0 };
  }
}

// ── Cost calculation ────────────────────────────────────────

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): { cost_input: number; cost_output: number; cost_total: number } {
  const pricing = pricingConfig.models[model] ?? pricingConfig.default;
  const cost_input = (inputTokens / 1_000_000) * pricing.input_per_1m;
  const cost_output = (outputTokens / 1_000_000) * pricing.output_per_1m;
  const cost_total = cost_input + cost_output;
  return {
    cost_input: Math.round(cost_input * 1_000_000) / 1_000_000,
    cost_output: Math.round(cost_output * 1_000_000) / 1_000_000,
    cost_total: Math.round(cost_total * 1_000_000) / 1_000_000,
  };
}

// ── Record usage (fire-and-forget) ──────────────────────────

export function recordUsage(record: UsageRecord): void {
  const line = JSON.stringify(record) + '\n';
  appendFile(USAGE_FILE, line).catch((err) => {
    log.error({ msg: 'usage_write_error', error: (err as Error).message });
  });
}

// ── Query: summary ──────────────────────────────────────────

interface SubSummary {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost: number;
}

export interface UsageSummary {
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost: number;
  by_model: Record<string, SubSummary>;
  by_category: Record<string, SubSummary>;
  by_date: Record<string, SubSummary>;
}

function addToSub(map: Record<string, SubSummary>, key: string, rec: UsageRecord): void {
  if (!map[key]) map[key] = { requests: 0, input_tokens: 0, output_tokens: 0, cost: 0 };
  map[key].requests++;
  map[key].input_tokens += rec.input_tokens;
  map[key].output_tokens += rec.output_tokens;
  map[key].cost += rec.cost_total;
}

export async function getUsageSummary(filters?: {
  from?: string;
  to?: string;
}): Promise<UsageSummary> {
  const summary: UsageSummary = {
    total_requests: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost: 0,
    by_model: {},
    by_category: {},
    by_date: {},
  };

  let stream;
  try {
    stream = createReadStream(USAGE_FILE, 'utf8');
  } catch {
    return summary;
  }

  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec: UsageRecord;
      try {
        rec = JSON.parse(line) as UsageRecord;
      } catch {
        continue;
      }

      const date = rec.ts.slice(0, 10);
      if (filters?.from && date < filters.from) continue;
      if (filters?.to && date > filters.to) continue;

      summary.total_requests++;
      summary.total_input_tokens += rec.input_tokens;
      summary.total_output_tokens += rec.output_tokens;
      summary.total_cost += rec.cost_total;

      addToSub(summary.by_model, rec.model, rec);
      addToSub(summary.by_category, rec.category, rec);
      addToSub(summary.by_date, date, rec);
    }
  } catch {
    // File may not exist yet
  }

  // Round totals
  summary.total_cost = Math.round(summary.total_cost * 1_000_000) / 1_000_000;
  for (const sub of [...Object.values(summary.by_model), ...Object.values(summary.by_category), ...Object.values(summary.by_date)]) {
    sub.cost = Math.round(sub.cost * 1_000_000) / 1_000_000;
  }

  return summary;
}

// ── Query: raw records ──────────────────────────────────────

export async function getUsageRaw(opts: {
  limit?: number;
  model?: string;
  category?: string;
  from?: string;
  to?: string;
}): Promise<UsageRecord[]> {
  const records: UsageRecord[] = [];
  const limit = opts.limit || 100;

  let stream;
  try {
    stream = createReadStream(USAGE_FILE, 'utf8');
  } catch {
    return records;
  }

  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec: UsageRecord;
      try {
        rec = JSON.parse(line) as UsageRecord;
      } catch {
        continue;
      }

      const date = rec.ts.slice(0, 10);
      if (opts.from && date < opts.from) continue;
      if (opts.to && date > opts.to) continue;
      if (opts.model && rec.model !== opts.model) continue;
      if (opts.category && rec.category !== opts.category) continue;

      records.push(rec);
    }
  } catch {
    // File may not exist yet
  }

  // Return last N records
  return records.slice(-limit);
}
