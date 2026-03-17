// ═══════════════════════════════════════════════════════════
// ClawBridge — Budget Controls
// ═══════════════════════════════════════════════════════════

import { budgetConfig, routingConfig } from './config.js';
import { getUsageSummary, getUsageRaw } from './usage.js';
import { log } from './logger.js';
import type { BudgetStatus, RegretStats, Category, Upstream } from './types.js';

// ── Derived limits ──────────────────────────────────────────

function daysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function getWeekStart(date: Date): string {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

// ── Budget status ───────────────────────────────────────────

export async function getBudgetStatus(): Promise<BudgetStatus> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';
  const weekStart = getWeekStart(now);

  const days = daysInMonth(now);
  const dailyLimit = budgetConfig.monthly_budget_usd / days;
  const weeklyLimit = budgetConfig.monthly_budget_usd / (days / 7);

  // Get spend for each horizon
  const dailySummary = await getUsageSummary({ from: today, to: today });
  const weeklySummary = await getUsageSummary({ from: weekStart, to: today });
  const monthlySummary = await getUsageSummary({ from: monthStart, to: today });

  const dailySpend = dailySummary.total_cost;
  const weeklySpend = weeklySummary.total_cost;
  const monthlySpend = monthlySummary.total_cost;

  const dailyPct = dailyLimit > 0 ? (dailySpend / dailyLimit) * 100 : 0;
  const weeklyPct = weeklyLimit > 0 ? (weeklySpend / weeklyLimit) * 100 : 0;
  const monthlyPct = budgetConfig.monthly_budget_usd > 0
    ? (monthlySpend / budgetConfig.monthly_budget_usd) * 100
    : 0;

  // Pacing: expected spend vs actual (linear)
  const dayOfMonth = now.getDate();
  const pacingExpected = (dayOfMonth / days) * budgetConfig.monthly_budget_usd;
  const pacingPct = pacingExpected > 0 ? (monthlySpend / pacingExpected) * 100 : 0;

  // Level: worst of daily/weekly/monthly
  const maxPct = Math.max(dailyPct, weeklyPct, monthlyPct);
  let level: BudgetStatus['level'] = 'normal';
  if (maxPct >= budgetConfig.hard_stop_pct) level = 'hard_stop';
  else if (maxPct >= budgetConfig.downgrade_threshold_pct) level = 'downgrade';
  else if (maxPct >= budgetConfig.warn_threshold_pct) level = 'warn';

  // Spike detection
  const alerts: string[] = [];
  let spikeDailyFlag = false;
  let spikeWeeklyFlag = false;

  // Daily spike: today vs 7-day average
  if (monthlySummary.by_date) {
    const dateKeys = Object.keys(monthlySummary.by_date).filter(d => d < today).sort().slice(-7);
    if (dateKeys.length >= 2) {
      const recentTotal = dateKeys.reduce((sum, d) => sum + (monthlySummary.by_date[d]?.cost || 0), 0);
      const avg7d = recentTotal / dateKeys.length;
      if (avg7d > 0 && dailySpend > avg7d * budgetConfig.spike_daily_multiplier) {
        spikeDailyFlag = true;
        alerts.push(`spike_daily: today $${dailySpend.toFixed(4)} vs ${dateKeys.length}d avg $${avg7d.toFixed(4)} (${(dailySpend / avg7d).toFixed(1)}x)`);
      }
    }
  }

  // Weekly spike: this week vs prior weeks
  if (monthlySummary.by_date) {
    const allDates = Object.keys(monthlySummary.by_date).sort();
    const priorWeekDates = allDates.filter(d => d < weekStart);
    if (priorWeekDates.length >= 7) {
      const priorTotal = priorWeekDates.reduce((sum, d) => sum + (monthlySummary.by_date[d]?.cost || 0), 0);
      const priorWeeks = priorWeekDates.length / 7;
      const avgWeekly = priorTotal / priorWeeks;
      if (avgWeekly > 0 && weeklySpend > avgWeekly * budgetConfig.spike_weekly_multiplier) {
        spikeWeeklyFlag = true;
        alerts.push(`spike_weekly: this week $${weeklySpend.toFixed(4)} vs avg $${avgWeekly.toFixed(4)} (${(weeklySpend / avgWeekly).toFixed(1)}x)`);
      }
    }
  }

  // Threshold alerts
  if (dailyPct >= budgetConfig.warn_threshold_pct) {
    alerts.push(`daily_spend_high: $${dailySpend.toFixed(4)} (${dailyPct.toFixed(0)}% of daily limit $${dailyLimit.toFixed(4)})`);
  }
  if (weeklyPct >= budgetConfig.warn_threshold_pct) {
    alerts.push(`weekly_spend_high: $${weeklySpend.toFixed(4)} (${weeklyPct.toFixed(0)}% of weekly limit $${weeklyLimit.toFixed(4)})`);
  }
  if (pacingPct > 120) {
    alerts.push(`pacing_over: $${monthlySpend.toFixed(4)} spent vs $${pacingExpected.toFixed(4)} expected (${pacingPct.toFixed(0)}%)`);
  }

  return {
    monthly_budget_usd: budgetConfig.monthly_budget_usd,
    daily_limit_usd: round2(dailyLimit),
    weekly_limit_usd: round2(weeklyLimit),
    daily_spend_usd: round6(dailySpend),
    weekly_spend_usd: round6(weeklySpend),
    monthly_spend_usd: round6(monthlySpend),
    daily_pct: round1(dailyPct),
    weekly_pct: round1(weeklyPct),
    monthly_pct: round1(monthlyPct),
    pacing_expected_usd: round2(pacingExpected),
    pacing_actual_usd: round6(monthlySpend),
    pacing_pct: round1(pacingPct),
    level,
    alerts,
    spike_daily: spikeDailyFlag,
    spike_weekly: spikeWeeklyFlag,
  };
}

// ── Budget downgrade ────────────────────────────────────────

function findUpstreamForModel(model: string): { upstream: Upstream; timeoutMs: number } | undefined {
  // Check routes first
  for (const route of Object.values(routingConfig.routes)) {
    if (route.model === model) {
      return { upstream: route.upstream, timeoutMs: route.timeoutMs };
    }
  }
  // Check fallback chain
  for (const step of routingConfig.fallback_chain) {
    if (step.model === model) {
      return { upstream: step.upstream, timeoutMs: step.timeoutMs };
    }
  }
  return undefined;
}

export function applyBudgetDowngrade(
  model: string,
  upstream: Upstream,
  category: Category,
  level: BudgetStatus['level'],
): { model: string; upstream: Upstream; downgraded: boolean } {
  // Never downgrade private categories
  if (category === 'private_simple' || category === 'private_complex') {
    return { model, upstream, downgraded: false };
  }

  if (level === 'hard_stop') {
    // Iterate to cheapest model
    let current = model;
    while (budgetConfig.downgrade_map[current]) {
      current = budgetConfig.downgrade_map[current];
    }
    if (current === model) return { model, upstream, downgraded: false };
    const route = findUpstreamForModel(current);
    return {
      model: current,
      upstream: route?.upstream ?? upstream,
      downgraded: true,
    };
  }

  if (level === 'downgrade') {
    const cheaper = budgetConfig.downgrade_map[model];
    if (!cheaper) return { model, upstream, downgraded: false };
    const route = findUpstreamForModel(cheaper);
    return {
      model: cheaper,
      upstream: route?.upstream ?? upstream,
      downgraded: true,
    };
  }

  return { model, upstream, downgraded: false };
}

// ── Regret stats ────────────────────────────────────────────

export async function getRegretStats(from?: string, to?: string): Promise<RegretStats> {
  const records = await getUsageRaw({ limit: 10000, from, to });
  const downgraded = records.filter(r => r.budget_downgraded);
  const downgradedAndFallback = downgraded.filter(r => r.fallback_used);

  return {
    total_requests: records.length,
    budget_downgrades: downgraded.length,
    downgrade_pct: records.length > 0
      ? round1((downgraded.length / records.length) * 100)
      : 0,
    downgrade_fallback_count: downgradedAndFallback.length,
    downgrade_fallback_pct: downgraded.length > 0
      ? round1((downgradedAndFallback.length / downgraded.length) * 100)
      : 0,
  };
}

// ── Helpers ─────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
