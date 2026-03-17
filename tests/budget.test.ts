import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyBudgetDowngrade, getBudgetStatus, getRegretStats } from '../src/budget.js';

// Mock config
vi.mock('../src/config.js', () => ({
  budgetConfig: {
    monthly_budget_usd: 50.00,
    warn_threshold_pct: 80,
    downgrade_threshold_pct: 90,
    hard_stop_pct: 100,
    spike_daily_multiplier: 3.0,
    spike_weekly_multiplier: 1.5,
    downgrade_map: {
      'claude-sonnet-4-5': 'claude-haiku-4-5',
      'claude-haiku-4-5': 'gemini-2.5-flash',
      'gemini-2.5-flash': 'gemini-2.5-flash-lite',
    },
  },
  routingConfig: {
    routes: {
      complex: { model: 'claude-sonnet-4-5', upstream: 'anthropic', timeoutMs: 60000, thinking: false },
      analysis: { model: 'gemini-2.5-flash', upstream: 'google', timeoutMs: 45000, thinking: false },
      action: { model: 'claude-haiku-4-5', upstream: 'anthropic', timeoutMs: 30000, thinking: false },
      batch: { model: 'gemini-2.5-flash-lite', upstream: 'google', timeoutMs: 20000, thinking: false },
      private_simple: { model: 'claude-haiku-4-5', upstream: 'anthropic', timeoutMs: 30000, thinking: false },
      private_complex: { model: 'claude-sonnet-4-5', upstream: 'anthropic', timeoutMs: 60000, thinking: false },
    },
    fallback_chain: [
      { model: 'gemini-2.5-flash', upstream: 'google', timeoutMs: 45000 },
      { model: 'claude-haiku-4-5', upstream: 'anthropic', timeoutMs: 30000 },
      { model: 'claude-sonnet-4-5', upstream: 'anthropic', timeoutMs: 60000 },
    ],
  },
}));

// Mock logger
vi.mock('../src/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock usage module
const mockGetUsageSummary = vi.fn();
const mockGetUsageRaw = vi.fn();
vi.mock('../src/usage.js', () => ({
  getUsageSummary: (...args: unknown[]) => mockGetUsageSummary(...args),
  getUsageRaw: (...args: unknown[]) => mockGetUsageRaw(...args),
}));

function emptySummary(cost = 0) {
  return {
    total_requests: cost > 0 ? 1 : 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost: cost,
    by_model: {},
    by_category: {},
    by_date: {},
  };
}

describe('applyBudgetDowngrade', () => {
  it('downgrades claude-sonnet to claude-haiku at downgrade level', () => {
    const result = applyBudgetDowngrade('claude-sonnet-4-5', 'anthropic', 'complex', 'downgrade');
    expect(result.model).toBe('claude-haiku-4-5');
    expect(result.upstream).toBe('anthropic');
    expect(result.downgraded).toBe(true);
  });

  it('downgrades claude-haiku to gemini-flash at downgrade level', () => {
    const result = applyBudgetDowngrade('claude-haiku-4-5', 'anthropic', 'action', 'downgrade');
    expect(result.model).toBe('gemini-2.5-flash');
    expect(result.upstream).toBe('google');
    expect(result.downgraded).toBe(true);
  });

  it('downgrades to cheapest model at hard_stop', () => {
    const result = applyBudgetDowngrade('claude-sonnet-4-5', 'anthropic', 'complex', 'hard_stop');
    expect(result.model).toBe('gemini-2.5-flash-lite');
    expect(result.upstream).toBe('google');
    expect(result.downgraded).toBe(true);
  });

  it('no-op for gemini-flash-lite (already cheapest)', () => {
    const result = applyBudgetDowngrade('gemini-2.5-flash-lite', 'google', 'batch', 'downgrade');
    expect(result.model).toBe('gemini-2.5-flash-lite');
    expect(result.downgraded).toBe(false);
  });

  it('never downgrades private_simple', () => {
    const result = applyBudgetDowngrade('claude-sonnet-4-5', 'anthropic', 'private_simple', 'hard_stop');
    expect(result.model).toBe('claude-sonnet-4-5');
    expect(result.downgraded).toBe(false);
  });

  it('never downgrades private_complex', () => {
    const result = applyBudgetDowngrade('claude-sonnet-4-5', 'anthropic', 'private_complex', 'downgrade');
    expect(result.model).toBe('claude-sonnet-4-5');
    expect(result.downgraded).toBe(false);
  });

  it('no-op at normal level', () => {
    const result = applyBudgetDowngrade('claude-sonnet-4-5', 'anthropic', 'complex', 'normal');
    expect(result.model).toBe('claude-sonnet-4-5');
    expect(result.downgraded).toBe(false);
  });

  it('no-op at warn level', () => {
    const result = applyBudgetDowngrade('claude-sonnet-4-5', 'anthropic', 'complex', 'warn');
    expect(result.model).toBe('claude-sonnet-4-5');
    expect(result.downgraded).toBe(false);
  });
});

describe('getBudgetStatus', () => {
  beforeEach(() => {
    mockGetUsageSummary.mockReset();
  });

  it('returns normal level when spend is low', async () => {
    // daily, weekly, monthly all return low spend
    mockGetUsageSummary
      .mockResolvedValueOnce(emptySummary(0.10))  // daily
      .mockResolvedValueOnce(emptySummary(0.50))   // weekly
      .mockResolvedValueOnce(emptySummary(2.00));   // monthly

    const status = await getBudgetStatus();
    expect(status.level).toBe('normal');
    expect(status.monthly_budget_usd).toBe(50.00);
    expect(status.daily_spend_usd).toBe(0.1);
    expect(status.weekly_spend_usd).toBe(0.5);
    expect(status.monthly_spend_usd).toBe(2.0);
    expect(status.alerts).toEqual([]);
  });

  it('returns warn level when daily spend hits 80% of daily limit', async () => {
    // $50/31 days ≈ $1.61 daily limit; 80% ≈ $1.29
    const dailyLimit = 50 / 31;
    const dailySpend = dailyLimit * 0.85; // 85%
    mockGetUsageSummary
      .mockResolvedValueOnce(emptySummary(dailySpend))  // daily
      .mockResolvedValueOnce(emptySummary(dailySpend))   // weekly
      .mockResolvedValueOnce(emptySummary(dailySpend));   // monthly

    const status = await getBudgetStatus();
    expect(status.level).toBe('warn');
  });

  it('returns downgrade level at 90%+ of limit', async () => {
    const dailyLimit = 50 / 31;
    const dailySpend = dailyLimit * 0.95; // 95%
    mockGetUsageSummary
      .mockResolvedValueOnce(emptySummary(dailySpend))
      .mockResolvedValueOnce(emptySummary(dailySpend))
      .mockResolvedValueOnce(emptySummary(dailySpend));

    const status = await getBudgetStatus();
    expect(status.level).toBe('downgrade');
  });

  it('returns hard_stop at 100%+ of limit', async () => {
    const dailyLimit = 50 / 31;
    const dailySpend = dailyLimit * 1.05; // 105%
    mockGetUsageSummary
      .mockResolvedValueOnce(emptySummary(dailySpend))
      .mockResolvedValueOnce(emptySummary(dailySpend))
      .mockResolvedValueOnce(emptySummary(dailySpend));

    const status = await getBudgetStatus();
    expect(status.level).toBe('hard_stop');
  });

  it('calculates pacing correctly', async () => {
    mockGetUsageSummary
      .mockResolvedValueOnce(emptySummary(1.00))   // daily
      .mockResolvedValueOnce(emptySummary(5.00))    // weekly
      .mockResolvedValueOnce(emptySummary(25.00));   // monthly

    const status = await getBudgetStatus();
    expect(status.pacing_actual_usd).toBe(25.0);
    expect(status.pacing_expected_usd).toBeGreaterThan(0);
    expect(status.pacing_pct).toBeGreaterThan(0);
  });
});

describe('getRegretStats', () => {
  beforeEach(() => {
    mockGetUsageRaw.mockReset();
  });

  it('returns zeros with no data', async () => {
    mockGetUsageRaw.mockResolvedValue([]);
    const stats = await getRegretStats();
    expect(stats.total_requests).toBe(0);
    expect(stats.budget_downgrades).toBe(0);
    expect(stats.downgrade_pct).toBe(0);
  });

  it('calculates downgrade percentages correctly', async () => {
    mockGetUsageRaw.mockResolvedValue([
      { budget_downgraded: true, fallback_used: false },
      { budget_downgraded: true, fallback_used: true },
      { budget_downgraded: false, fallback_used: false },
      { budget_downgraded: false, fallback_used: false },
    ]);
    const stats = await getRegretStats();
    expect(stats.total_requests).toBe(4);
    expect(stats.budget_downgrades).toBe(2);
    expect(stats.downgrade_pct).toBe(50);
    expect(stats.downgrade_fallback_count).toBe(1);
    expect(stats.downgrade_fallback_pct).toBe(50);
  });
});
