// ═══════════════════════════════════════════════════════════
// ClawBridge — Router (orchestrator)
// ═══════════════════════════════════════════════════════════

import { routingConfig } from './config.js';
import { classifyByRules } from './classifier_rules.js';
import { classifyByT0 } from './classifier_t0.js';
import { getBudgetStatus, applyBudgetDowngrade } from './budget.js';
import { applyCapabilityUpgrade } from './capabilities.js';
import { reorderFallbackChain, getModelHealthScore } from './health.js';
import { checkTierRateLimit } from './rate-limiter.js';
import { log } from './logger.js';
import type {
  AnthropicRequestBody,
  Category,
  ClassifierResult,
  DecisionTrace,
  RoutingDecision,
} from './types.js';

// ── Extract user text from Anthropic messages ───────────────

function extractMessageText(msg: { content: string | Array<{ type: string; text?: string }> }): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join(' ');
  }
  return '';
}

/**
 * Extract user text for classification.
 * Returns two strings:
 * - recentText: last 3 user messages (for privacy gate — broader context)
 * - lastText: last user message only (for category scoring — current intent)
 */
export function extractUserText(body: AnthropicRequestBody): { recentText: string; lastText: string } {
  if (!body.messages || !Array.isArray(body.messages)) return { recentText: '', lastText: '' };

  const userMessages = body.messages.filter(m => m.role === 'user');
  const recent = userMessages.slice(-3).map(extractMessageText);
  const last = userMessages.slice(-1).map(extractMessageText);

  return {
    recentText: recent.join(' '),
    lastText: last.join(' '),
  };
}

// ── Escalation map ──────────────────────────────────────────

const ESCALATION_MAP: Partial<Record<Category, Category>> = {
  default: 'action',
  batch: 'action',
  action: 'analysis',
  analysis: 'complex',
};

// ── Main route function ─────────────────────────────────────

export async function route(
  body: AnthropicRequestBody,
): Promise<RoutingDecision> {
  const { recentText, lastText } = extractUserText(body);
  const config = routingConfig;

  const trace: DecisionTrace = {
    privacy_gate: false,
    rules_hit: [],
    classifier_used: false,
  };

  // Step 1: Rules-based classification
  // Privacy gate checks recent context (last 3 messages)
  // Category scoring checks only the last message (current intent)
  let result: ClassifierResult = classifyByRules(recentText, lastText, config, body);
  trace.rules_hit = [...result.rules_hit];

  // Check if privacy gate was triggered
  if (result.category === 'private_simple' || result.category === 'private_complex') {
    trace.privacy_gate = true;
    trace.privacy_reason = result.rules_hit.find(r => r.startsWith('privacy_gate:'));
  }

  // Step 2: If confidence below threshold and NOT private, use T0
  if (
    !trace.privacy_gate &&
    result.confidence < config.classifier.rules_to_t0_threshold
  ) {
    trace.classifier_used = true;
    const t0Start = Date.now();

    result = await classifyByT0(
      lastText,
      result,
      config.classifier.t0_model,
      config.classifier.t0_timeout_ms,
    );

    trace.t0_latency_ms = Date.now() - t0Start;
    trace.t0_category = result.category;
    trace.rules_hit = [...result.rules_hit];
  }

  // Step 3: Confidence-based escalation (never downgrade when uncertain)
  if (
    !trace.privacy_gate &&
    result.confidence < config.classifier.escalation_threshold
  ) {
    const escalated = ESCALATION_MAP[result.category];
    if (escalated) {
      trace.escalated = true;
      trace.original_category = result.category;
      result = { ...result, category: escalated };
      log.info({
        msg: 'escalated',
        from: trace.original_category,
        to: escalated,
        confidence: result.confidence,
      });
    }
  }

  // Step 4: Lookup route config
  const routeKey = result.category as string;
  const routeEntry = config.routes[routeKey] || config.routes['default'];
  let routeModel = routeEntry.model;
  let routeUpstream = routeEntry.upstream;
  let routeTimeoutMs = routeEntry.timeoutMs;
  let routeThinking = routeEntry.thinking;

  // Step 4a: Rate limit check
  const rateLimit = await checkTierRateLimit(result.category);
  if (rateLimit.blocked && !trace.privacy_gate) {
    trace.rate_limited = true;
    trace.rate_limit_tier = result.category;

    // Use fallback_map for this tier if available
    const fallbackEntry = config.fallback_map?.[result.category];
    if (fallbackEntry) {
      trace.rate_limit_fallback = `${fallbackEntry.upstream}/${fallbackEntry.model}`;
      routeModel = fallbackEntry.model;
      routeUpstream = fallbackEntry.upstream;
      routeTimeoutMs = fallbackEntry.timeoutMs;
      routeThinking = false;
      log.warn({
        msg: 'rate_limited',
        tier: result.category,
        fallback_to: trace.rate_limit_fallback,
        hourly: `${rateLimit.hourly_used}/${rateLimit.hourly_limit}`,
        daily: `${rateLimit.daily_used}/${rateLimit.daily_limit}`,
        oauth_blocked: rateLimit.oauth_blocked,
      });
    }
  }

  // Step 4b: Budget-aware downgrade
  const budgetStatus = await getBudgetStatus();
  trace.budget_level = budgetStatus.level;

  if (budgetStatus.level !== 'normal' && !trace.privacy_gate) {
    // At warn level, only downgrade if confidence is moderate
    const shouldDowngrade = !(budgetStatus.level === 'warn' && result.confidence >= 0.7);

    if (shouldDowngrade) {
      const dg = applyBudgetDowngrade(routeModel, routeUpstream, result.category, budgetStatus.level);
      if (dg.downgraded) {
        trace.budget_downgrade = true;
        trace.budget_original_model = routeModel;
        routeModel = dg.model;
        routeUpstream = dg.upstream;
        log.warn({
          msg: 'budget_downgrade',
          from: trace.budget_original_model,
          to: routeModel,
          level: budgetStatus.level,
          confidence: result.confidence,
        });
      }
    }
  }

  // Step 4c: Capability-aware upgrade
  // If the selected model lacks required capabilities (tool_use, vision, etc.), upgrade
  const capResult = applyCapabilityUpgrade(routeModel, routeUpstream, body, lastText);
  if (capResult.upgraded) {
    trace.capability_upgrade = true;
    trace.capability_original_model = routeModel;
    trace.capability_required = capResult.check.required;
    trace.capability_missing = capResult.check.missing;
    routeModel = capResult.model;
    routeUpstream = capResult.upstream;
  }

  // Step 5: Build fallback chain (excluding the primary model)
  const staticChain = config.fallback_chain.filter(
    step => step.model !== routeModel || step.upstream !== routeUpstream,
  );

  // Step 5b: Reorder fallback chain by health score (SLO-aware)
  const { reordered: fallback_chain, wasReordered } = reorderFallbackChain(staticChain);
  if (wasReordered) {
    trace.fallback_reordered = true;
  }
  trace.primary_health_score = getModelHealthScore(routeModel, routeUpstream);

  const decision: RoutingDecision = {
    category: result.category,
    model: routeModel,
    upstream: routeUpstream,
    timeoutMs: routeTimeoutMs,
    thinking: routeThinking,
    confidence: result.confidence,
    fallback_chain,
    decision_trace: trace,
  };

  log.info({
    msg: 'route_decision',
    category: decision.category,
    model: decision.model,
    upstream: decision.upstream,
    confidence: decision.confidence,
    thinking: decision.thinking,
    privacy: trace.privacy_gate,
    t0_used: trace.classifier_used,
  });

  return decision;
}
