// ═══════════════════════════════════════════════════════════
// ClawBridge — Rate Limiter (per-tier + OAuth global)
// ═══════════════════════════════════════════════════════════

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rateLimitConfig } from './config.js';
import type { RateLimitConfig, RateLimitStatus, UsageRecord } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const USAGE_FILE = join(__dirname, '..', 'data', 'usage.jsonl');

// ── Count recent requests ───────────────────────────────────

async function countRecentByCategory(
  category: string | null,
  categories: string[] | null,
  sinceMs: number,
): Promise<number> {
  let count = 0;
  const cutoff = new Date(Date.now() - sinceMs).toISOString();

  let stream;
  try {
    stream = createReadStream(USAGE_FILE, 'utf8');
  } catch {
    return 0;
  }

  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as UsageRecord;
        if (record.ts < cutoff) continue;

        if (category && record.category === category) {
          count++;
        } else if (categories && categories.includes(record.category)) {
          count++;
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file read error */ }

  return count;
}

// ── Tier rate limit check ───────────────────────────────────

const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

export async function checkTierRateLimit(category: string): Promise<RateLimitStatus> {
  const config = rateLimitConfig;

  const tierLimit = config?.tiers?.[category];
  const hourlyLimit = tierLimit?.hourly ?? Infinity;
  const dailyLimit = tierLimit?.daily ?? Infinity;

  const [hourlyUsed, dailyUsed] = await Promise.all([
    countRecentByCategory(category, null, ONE_HOUR),
    countRecentByCategory(category, null, ONE_DAY),
  ]);

  const blocked = hourlyUsed >= hourlyLimit || dailyUsed >= dailyLimit;

  // Check OAuth global if this is an oauth tier
  const oauthTiers = config?.oauth_tiers || [];
  let oauthHourlyUsed = 0;
  let oauthDailyUsed = 0;
  let oauthBlocked = false;

  if (oauthTiers.includes(category)) {
    const oauthGlobal = config?.oauth_global;
    if (oauthGlobal) {
      [oauthHourlyUsed, oauthDailyUsed] = await Promise.all([
        countRecentByCategory(null, oauthTiers, ONE_HOUR),
        countRecentByCategory(null, oauthTiers, ONE_DAY),
      ]);
      oauthBlocked = oauthHourlyUsed >= oauthGlobal.hourly || oauthDailyUsed >= oauthGlobal.daily;
    }
  }

  return {
    tier: category,
    hourly_used: hourlyUsed,
    hourly_limit: hourlyLimit,
    daily_used: dailyUsed,
    daily_limit: dailyLimit,
    blocked: blocked || oauthBlocked,
    oauth_hourly_used: oauthHourlyUsed,
    oauth_daily_used: oauthDailyUsed,
    oauth_blocked: oauthBlocked,
  };
}

// ── OAuth priority blocking ─────────────────────────────────

export async function shouldBlockForOAuthPriority(category: string): Promise<boolean> {
  const config = rateLimitConfig;
  if (!config) return false;

  const oauthTiers = config.oauth_tiers || [];
  if (!oauthTiers.includes(category)) return false;

  const oauthGlobal = config.oauth_global;
  if (!oauthGlobal) return false;

  const dailyUsed = await countRecentByCategory(null, oauthTiers, ONE_DAY);
  const threshold = oauthGlobal.daily * 0.8; // 80% threshold

  if (dailyUsed < threshold) return false;

  // Block lower-priority tiers first
  const priority = config.oauth_priority || [];
  const categoryIdx = priority.indexOf(category);
  if (categoryIdx < 0) return true; // not in priority list → block

  // Only block if there are higher-priority tiers that haven't been blocked
  // Higher priority = earlier in the array
  // Lower priority tiers (later in array) get blocked first
  const totalTiers = priority.length;
  const tiersThatShouldBeBlocked = Math.ceil((dailyUsed / oauthGlobal.daily) * totalTiers);

  // Block from the end (lowest priority first)
  return categoryIdx >= totalTiers - tiersThatShouldBeBlocked;
}

// ── Get all rate limit statuses ─────────────────────────────

export async function getAllRateLimitStatus(): Promise<{
  tiers: RateLimitStatus[];
  oauth_global: { hourly_used: number; hourly_limit: number; daily_used: number; daily_limit: number; blocked: boolean };
}> {
  const config = rateLimitConfig;
  const tiers: RateLimitStatus[] = [];

  if (config?.tiers) {
    for (const tier of Object.keys(config.tiers)) {
      tiers.push(await checkTierRateLimit(tier));
    }
  }

  const oauthTiers = config?.oauth_tiers || [];
  const oauthGlobal = config?.oauth_global || { hourly: 999, daily: 999 };
  const [oauthHourly, oauthDaily] = await Promise.all([
    countRecentByCategory(null, oauthTiers, ONE_HOUR),
    countRecentByCategory(null, oauthTiers, ONE_DAY),
  ]);

  return {
    tiers,
    oauth_global: {
      hourly_used: oauthHourly,
      hourly_limit: oauthGlobal.hourly,
      daily_used: oauthDaily,
      daily_limit: oauthGlobal.daily,
      blocked: oauthHourly >= oauthGlobal.hourly || oauthDaily >= oauthGlobal.daily,
    },
  };
}
