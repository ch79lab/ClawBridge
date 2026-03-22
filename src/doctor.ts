#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// ClawBridge — Doctor (deployment diagnostics)
// ═══════════════════════════════════════════════════════════

import { existsSync, readFileSync, accessSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

const checks: Check[] = [];

function ok(name: string, detail: string): void {
  checks.push({ name, status: 'ok', detail });
}
function warn(name: string, detail: string): void {
  checks.push({ name, status: 'warn', detail });
}
function fail(name: string, detail: string): void {
  checks.push({ name, status: 'fail', detail });
}

// ── .env file ────────────────────────────────────────────

function checkEnvFile(): void {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) {
    fail('.env', 'File not found. Copy .env.example to .env and fill in your keys.');
    return;
  }
  const content = readFileSync(envPath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  const keys = new Map<string, string>();
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      keys.set(line.slice(0, eq).trim(), val);
    }
  }

  // ANTHROPIC_API_KEY
  const anthKey = keys.get('ANTHROPIC_API_KEY') || process.env.ANTHROPIC_API_KEY || '';
  if (!anthKey) {
    fail('ANTHROPIC_API_KEY', 'Missing. Required for all Anthropic routes.');
  } else if (anthKey === 'sk-ant-...' || anthKey.length < 10) {
    fail('ANTHROPIC_API_KEY', 'Placeholder value detected. Set a real API key.');
  } else if (anthKey.startsWith('sk-ant-')) {
    ok('ANTHROPIC_API_KEY', `Set (${anthKey.slice(0, 12)}...)`);
  } else {
    warn('ANTHROPIC_API_KEY', `Set but unexpected format (${anthKey.slice(0, 8)}...)`);
  }

  // GOOGLE_API_KEY
  const googleKey = keys.get('GOOGLE_API_KEY') || process.env.GOOGLE_API_KEY || '';
  if (!googleKey || googleKey === '...') {
    warn('GOOGLE_API_KEY', 'Missing. Google routes (analysis, batch) will fail.');
  } else {
    ok('GOOGLE_API_KEY', `Set (${googleKey.slice(0, 8)}...)`);
  }

  ok('.env', `Found with ${keys.size} keys`);
}

// ── Config files ─────────────────────────────────────────

function checkConfig(filename: string, required: boolean, validator?: (data: unknown) => string | null): void {
  const path = join(ROOT, 'config', filename);
  if (!existsSync(path)) {
    if (required) {
      fail(`config/${filename}`, 'File not found. This file is required.');
    } else {
      warn(`config/${filename}`, 'File not found. Using defaults.');
    }
    return;
  }
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (validator) {
      const err = validator(data);
      if (err) {
        fail(`config/${filename}`, err);
        return;
      }
    }
    ok(`config/${filename}`, 'Valid JSON, schema checks passed');
  } catch (e) {
    fail(`config/${filename}`, `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function validateRouting(data: unknown): string | null {
  const cfg = data as Record<string, unknown>;
  if (!cfg.routes) return 'Missing "routes" section';
  if (!cfg.fallback_chain) return 'Missing "fallback_chain" section';
  if (!cfg.classifier) return 'Missing "classifier" section';
  if (!cfg.privacy) return 'Missing "privacy" section';
  if (!cfg.rules) return 'Missing "rules" section';

  const routes = cfg.routes as Record<string, unknown>;
  const required = ['default', 'complex', 'analysis', 'action', 'batch', 'private_simple', 'private_complex', 'vision', 'code', 'deep_analysis'];
  const missing = required.filter(c => !routes[c]);
  if (missing.length > 0) return `Missing routes: ${missing.join(', ')}`;

  for (const cat of required) {
    const route = routes[cat] as Record<string, unknown>;
    if (!route.model) return `Route "${cat}" missing "model"`;
    if (!route.upstream) return `Route "${cat}" missing "upstream"`;
    if (typeof route.timeoutMs !== 'number') return `Route "${cat}" missing "timeoutMs"`;
  }

  return null;
}

function validateBudget(data: unknown): string | null {
  const cfg = data as Record<string, unknown>;
  if (typeof cfg.monthly_budget_usd !== 'number') return 'Missing "monthly_budget_usd"';
  if (typeof cfg.warn_threshold_pct !== 'number') return 'Missing "warn_threshold_pct"';
  if (typeof cfg.downgrade_threshold_pct !== 'number') return 'Missing "downgrade_threshold_pct"';
  if (typeof cfg.downgrade_map !== 'object') return 'Missing "downgrade_map"';
  return null;
}

function validatePricing(data: unknown): string | null {
  const cfg = data as Record<string, unknown>;
  if (!cfg.models || typeof cfg.models !== 'object') return 'Missing "models" section';
  if (!cfg.default || typeof cfg.default !== 'object') return 'Missing "default" section';
  return null;
}

function validateCapabilities(data: unknown): string | null {
  const cfg = data as Record<string, unknown>;
  if (!cfg.models || typeof cfg.models !== 'object') return 'Missing "models" section';
  if (!cfg.request_detection || typeof cfg.request_detection !== 'object') return 'Missing "request_detection" section';
  return null;
}

function validateRateLimits(data: unknown): string | null {
  const cfg = data as Record<string, unknown>;
  if (!cfg.tiers || typeof cfg.tiers !== 'object') return 'Missing "tiers" section';
  if (!cfg.oauth_global || typeof cfg.oauth_global !== 'object') return 'Missing "oauth_global" section';
  return null;
}

// ── Auth config ──────────────────────────────────────────

function checkAuthConfig(): void {
  const path = join(ROOT, 'config', 'auth.json');
  if (!existsSync(path)) {
    warn('config/auth.json', 'Not found. Using hardcoded API key auth (backward-compatible).');
    return;
  }

  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!data.providers || typeof data.providers !== 'object') {
      fail('config/auth.json', 'Missing "providers" section');
      return;
    }

    const providers = data.providers as Record<string, Record<string, string>>;
    let hasIssue = false;

    for (const [name, config] of Object.entries(providers)) {
      const envVar = config.credential_env;
      if (!envVar) {
        fail(`auth:${name}`, 'Missing "credential_env"');
        hasIssue = true;
        continue;
      }

      // Read from .env file or process.env
      const envPath = join(ROOT, '.env');
      let envValue = process.env[envVar];
      if (!envValue && existsSync(envPath)) {
        const envContent = readFileSync(envPath, 'utf8');
        const match = envContent.match(new RegExp(`^${envVar}=(.+)$`, 'm'));
        if (match) envValue = match[1].trim().replace(/^["']|["']$/g, '');
      }

      if (!envValue || envValue === '...' || envValue === 'sk-ant-...' || envValue === 'sk-...') {
        warn(`auth:${name}`, `${envVar} not set or placeholder. ${name} routes will fail.`);
      } else {
        ok(`auth:${name}`, `${config.method} via ${config.header} (${envVar}=${envValue.slice(0, 8)}...)`);
      }
    }

    if (!hasIssue) {
      ok('config/auth.json', `Valid — ${Object.keys(providers).length} providers configured`);
    }
  } catch (e) {
    fail('config/auth.json', `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Data directory ───────────────────────────────────────

function checkDataDir(): void {
  const dataDir = join(ROOT, 'data');
  if (!existsSync(dataDir)) {
    warn('data/', 'Directory does not exist. It will be created on first request.');
    return;
  }
  try {
    accessSync(dataDir, constants.W_OK);
    ok('data/', 'Exists and writable');
  } catch {
    fail('data/', 'Directory exists but is not writable');
  }
}

// ── Port availability ────────────────────────────────────

function checkPort(port: number): Promise<void> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' }, () => {
      socket.end();
      // Port is in use — could be ClawBridge already running
      warn(`port ${port}`, 'Port is already in use. ClawBridge may already be running.');
      resolve();
    });
    socket.on('error', () => {
      ok(`port ${port}`, 'Available');
      resolve();
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      ok(`port ${port}`, 'Available');
      resolve();
    });
  });
}

// ── Upstream connectivity ────────────────────────────────

async function checkUpstream(name: string, url: string, timeoutMs = 5000): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timeout);
    if (response.ok || response.status === 401 || response.status === 403 || response.status === 404) {
      // 401/403 = reachable but auth issue (expected for API endpoints without proper auth)
      // 404 = reachable but wrong path (expected)
      ok(`upstream:${name}`, `Reachable (HTTP ${response.status})`);
    } else {
      warn(`upstream:${name}`, `Responded with HTTP ${response.status}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('abort')) {
      fail(`upstream:${name}`, `Timeout after ${timeoutMs}ms`);
    } else {
      fail(`upstream:${name}`, `Unreachable: ${msg}`);
    }
  }
}

// ── Routing coherence ────────────────────────────────────

function checkRoutingCoherence(): void {
  const routingPath = join(ROOT, 'config', 'routing.json');
  const pricingPath = join(ROOT, 'config', 'pricing.json');
  if (!existsSync(routingPath) || !existsSync(pricingPath)) return;

  try {
    const routing = JSON.parse(readFileSync(routingPath, 'utf8'));
    const pricing = JSON.parse(readFileSync(pricingPath, 'utf8'));

    const routedModels = new Set<string>();
    for (const route of Object.values(routing.routes) as Array<{ model: string }>) {
      routedModels.add(route.model);
    }
    for (const step of routing.fallback_chain as Array<{ model: string }>) {
      routedModels.add(step.model);
    }

    const unpriced = [...routedModels].filter(m => !pricing.models?.[m]);
    if (unpriced.length > 0) {
      warn('coherence:pricing', `Models in routing but not in pricing.json: ${unpriced.join(', ')}. Cost tracking will use $0.`);
    } else {
      ok('coherence:pricing', 'All routed models have pricing defined');
    }
  } catch {
    // Already caught by individual config checks
  }
}

// ── Main ─────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n  ClawBridge Doctor\n  =================\n');

  // Sync checks
  checkEnvFile();
  checkConfig('routing.json', true, validateRouting);
  checkConfig('pricing.json', false, validatePricing);
  checkConfig('budget.json', false, validateBudget);
  checkConfig('capabilities.json', false, validateCapabilities);
  checkConfig('rate-limits.json', false, validateRateLimits);
  checkAuthConfig();
  checkDataDir();
  checkRoutingCoherence();

  // Async checks
  const port = parseInt(process.env.PORT || '8402', 10);
  await checkPort(port);
  await checkUpstream('anthropic', 'https://api.anthropic.com/v1/messages');
  await checkUpstream('google', 'https://generativelanguage.googleapis.com/v1beta/models');
  await checkUpstream('openrouter', 'https://openrouter.ai/api/v1/models');

  // Print results
  let hasFailure = false;
  for (const c of checks) {
    const icon = c.status === 'ok' ? '\x1b[32m[OK]\x1b[0m' : c.status === 'warn' ? '\x1b[33m[!!]\x1b[0m' : '\x1b[31m[FAIL]\x1b[0m';
    console.log(`  ${icon}  ${c.name}`);
    console.log(`        ${c.detail}`);
    if (c.status === 'fail') hasFailure = true;
  }

  const fails = checks.filter(c => c.status === 'fail').length;
  const warns = checks.filter(c => c.status === 'warn').length;
  const oks = checks.filter(c => c.status === 'ok').length;

  console.log(`\n  Summary: ${oks} ok, ${warns} warnings, ${fails} failures\n`);

  if (hasFailure) {
    console.log('  Fix the failures above before starting ClawBridge.\n');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Doctor failed:', e);
  process.exit(1);
});
