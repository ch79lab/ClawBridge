// ═══════════════════════════════════════════════════════════
// ClawBridge — Capability-Aware Routing
// ═══════════════════════════════════════════════════════════

import { routingConfig, capabilitiesConfig } from './config.js';
import { estimateTokens } from './token_estimator.js';
import { log } from './logger.js';
import type {
  AnthropicRequestBody,
  Capability,
  CapabilityCheck,
  ModelCapabilities,
  Upstream,
} from './types.js';

const capConfig = capabilitiesConfig;

// ── Detect required capabilities from request ────────────

export function detectRequiredCapabilities(
  body: AnthropicRequestBody,
  userText: string,
): Capability[] {
  if (!capConfig) return [];

  const required: Capability[] = [];

  // Tool use: request has tools defined
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    required.push('tool_use');
  }

  // Vision: any message contains image content blocks
  const hasImages = (body.messages || []).some(m => {
    if (!Array.isArray(m.content)) return false;
    return m.content.some(b => b.type === 'image' || b.type === 'image_url');
  });
  if (hasImages) {
    required.push('vision');
  }

  // Long context: estimated tokens exceed threshold
  const threshold = capConfig.request_detection.long_context.token_threshold;
  const estimated = estimateTokens(userText);
  if (estimated > threshold) {
    required.push('long_context');
  }

  return required;
}

// ── Get model capabilities ───────────────────────────────

export function getModelCapabilities(model: string): ModelCapabilities | null {
  if (!capConfig) return null;
  return capConfig.models[model] || null;
}

// ── Check if model supports required capabilities ────────

export function checkCapabilities(
  model: string,
  upstream: Upstream,
  required: Capability[],
): CapabilityCheck {
  if (!capConfig || required.length === 0) {
    return { required, missing: [], upgrade_needed: false };
  }

  const modelCaps = capConfig.models[model];
  if (!modelCaps) {
    // Unknown model — can't check, assume ok
    return { required, missing: [], upgrade_needed: false };
  }

  const missing = required.filter(cap => !modelCaps.capabilities.includes(cap));

  if (missing.length === 0) {
    return { required, missing: [], upgrade_needed: false };
  }

  // Find an upgrade that satisfies all required capabilities
  const upgrade = findUpgrade(model, required);
  if (upgrade) {
    return {
      required,
      missing,
      upgrade_needed: true,
      upgraded_model: upgrade.model,
      upgraded_upstream: upgrade.upstream,
      reason: `Model ${model} lacks: ${missing.join(', ')}. Upgraded to ${upgrade.model}.`,
    };
  }

  // No upgrade available — return the gap info
  return {
    required,
    missing,
    upgrade_needed: true,
    reason: `Model ${model} lacks: ${missing.join(', ')}. No suitable upgrade found.`,
  };
}

// ── Find upgrade model ───────────────────────────────────

function findUpgrade(
  currentModel: string,
  required: Capability[],
): { model: string; upstream: Upstream } | null {
  if (!capConfig) return null;

  let candidate = currentModel;
  const visited = new Set<string>();

  while (capConfig.upgrade_path[candidate]) {
    candidate = capConfig.upgrade_path[candidate];
    if (visited.has(candidate)) break; // prevent cycles
    visited.add(candidate);

    const caps = capConfig.models[candidate];
    if (!caps) continue;

    const satisfied = required.every(r => caps.capabilities.includes(r));
    if (satisfied) {
      // Find upstream for this model
      const upstream = findUpstreamForModel(candidate);
      if (upstream) {
        return { model: candidate, upstream };
      }
    }
  }

  return null;
}

// ── Find upstream for a model ────────────────────────────

function findUpstreamForModel(model: string): Upstream | null {
  for (const route of Object.values(routingConfig.routes)) {
    if (route.model === model) return route.upstream;
  }
  for (const step of routingConfig.fallback_chain) {
    if (step.model === model) return step.upstream;
  }
  return null;
}

// ── Apply capability upgrade to routing ──────────────────

export function applyCapabilityUpgrade(
  model: string,
  upstream: Upstream,
  body: AnthropicRequestBody,
  userText: string,
): { model: string; upstream: Upstream; upgraded: boolean; check: CapabilityCheck } {
  const required = detectRequiredCapabilities(body, userText);
  const check = checkCapabilities(model, upstream, required);

  if (!check.upgrade_needed || !check.upgraded_model || !check.upgraded_upstream) {
    return { model, upstream, upgraded: false, check };
  }

  log.warn({
    msg: 'capability_upgrade',
    from: model,
    to: check.upgraded_model,
    required: check.required,
    missing: check.missing,
  });

  return {
    model: check.upgraded_model,
    upstream: check.upgraded_upstream,
    upgraded: true,
    check,
  };
}
