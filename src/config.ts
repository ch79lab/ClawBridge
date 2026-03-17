// ═══════════════════════════════════════════════════════════
// ClawBridge — Configuration
// ═══════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RoutingConfig, PricingConfig, BudgetConfig, CapabilitiesConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Load .env ───────────────────────────────────────────────

function loadDotEnv(): void {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

// ── Load routing.json ───────────────────────────────────────

function loadRoutingConfig(): RoutingConfig {
  const configPath = join(ROOT, 'config', 'routing.json');
  if (!existsSync(configPath)) {
    throw new Error(`[FATAL] routing.json not found at ${configPath}`);
  }
  const raw = readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(raw) as RoutingConfig;

  // Validate required fields
  if (!cfg.routes) throw new Error('[FATAL] routing.json: missing "routes"');
  if (!cfg.fallback_chain) throw new Error('[FATAL] routing.json: missing "fallback_chain"');
  if (!cfg.classifier) throw new Error('[FATAL] routing.json: missing "classifier"');
  if (!cfg.privacy) throw new Error('[FATAL] routing.json: missing "privacy"');
  if (!cfg.rules) throw new Error('[FATAL] routing.json: missing "rules"');

  const requiredCategories = ['complex', 'analysis', 'action', 'batch', 'private_simple', 'private_complex'] as const;
  for (const cat of requiredCategories) {
    if (!cfg.routes[cat]) {
      throw new Error(`[FATAL] routing.json: missing route for category "${cat}"`);
    }
  }

  return cfg;
}

export const routingConfig: RoutingConfig = loadRoutingConfig();

// ── Load pricing.json ───────────────────────────────────────

function loadPricingConfig(): PricingConfig {
  const configPath = join(ROOT, 'config', 'pricing.json');
  if (!existsSync(configPath)) {
    return { models: {}, default: { input_per_1m: 0, output_per_1m: 0 } };
  }
  return JSON.parse(readFileSync(configPath, 'utf8')) as PricingConfig;
}

export const pricingConfig: PricingConfig = loadPricingConfig();

// ── Load budget.json ────────────────────────────────────────

function loadBudgetConfig(): BudgetConfig {
  const configPath = join(ROOT, 'config', 'budget.json');
  if (!existsSync(configPath)) {
    return {
      monthly_budget_usd: 999,
      warn_threshold_pct: 80,
      downgrade_threshold_pct: 90,
      hard_stop_pct: 100,
      spike_daily_multiplier: 3.0,
      spike_weekly_multiplier: 1.5,
      downgrade_map: {},
    };
  }
  return JSON.parse(readFileSync(configPath, 'utf8')) as BudgetConfig;
}

export const budgetConfig: BudgetConfig = loadBudgetConfig();

// ── Load capabilities.json ──────────────────────────────

function loadCapabilitiesConfig(): CapabilitiesConfig | null {
  const configPath = join(ROOT, 'config', 'capabilities.json');
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as CapabilitiesConfig;
  } catch {
    return null;
  }
}

export const capabilitiesConfig: CapabilitiesConfig | null = loadCapabilitiesConfig();

// ── Environment accessors ───────────────────────────────────

export function getPort(): number {
  return parseInt(process.env.PORT || '8402', 10);
}

export function getOllamaUrl(): string {
  return process.env.OLLAMA_URL || 'http://localhost:11434';
}

export function getAnthropicApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('[FATAL] ANTHROPIC_API_KEY is required');
  return key;
}

export function getAnthropicBaseUrl(): string {
  return process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
}

export function getGoogleApiKey(): string {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('[FATAL] GOOGLE_API_KEY is required. Set it in .env or remove Google routes from routing.json');
  return key;
}

export function hasGoogleApiKey(): boolean {
  return !!process.env.GOOGLE_API_KEY;
}

export function getLogLevel(): string {
  return process.env.LOG_LEVEL || 'info';
}

export function isShadowMode(): boolean {
  return process.env.SHADOW_MODE === 'true';
}

export function shouldStorePreview(): boolean {
  return process.env.STORE_MESSAGE_PREVIEW === 'true';
}
