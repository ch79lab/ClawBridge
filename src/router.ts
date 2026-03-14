// ═══════════════════════════════════════════════════════════
// ClawBridge — Router (orchestrator)
// ═══════════════════════════════════════════════════════════

import { routingConfig } from './config.js';
import { classifyByRules } from './classifier_rules.js';
import { classifyByT0 } from './classifier_t0.js';
import { log } from './logger.js';
import type {
  AnthropicRequestBody,
  Category,
  ClassifierResult,
  DecisionTrace,
  RoutingDecision,
} from './types.js';

// ── Extract user text from Anthropic messages ───────────────

export function extractUserText(body: AnthropicRequestBody): string {
  if (!body.messages || !Array.isArray(body.messages)) return '';
  return body.messages
    .filter(m => m.role === 'user')
    .slice(-3)
    .map(m => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter(b => b.type === 'text')
          .map(b => b.text || '')
          .join(' ');
      }
      return '';
    })
    .join(' ');
}

// ── Escalation map ──────────────────────────────────────────

const ESCALATION_MAP: Partial<Record<Category, Category>> = {
  batch: 'action',
  action: 'analysis',
  analysis: 'complex',
};

// ── Main route function ─────────────────────────────────────

export async function route(
  body: AnthropicRequestBody,
): Promise<RoutingDecision> {
  const userText = extractUserText(body);
  const config = routingConfig;

  const trace: DecisionTrace = {
    privacy_gate: false,
    rules_hit: [],
    classifier_used: false,
  };

  // Step 1: Rules-based classification (includes privacy gate)
  let result: ClassifierResult = classifyByRules(userText, config);
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
      userText,
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
  const routeConfig = config.routes[result.category];

  // Step 5: Build fallback chain (excluding the primary model)
  const fallback_chain = config.fallback_chain.filter(
    step => step.model !== routeConfig.model || step.upstream !== routeConfig.upstream,
  );

  const decision: RoutingDecision = {
    category: result.category,
    model: routeConfig.model,
    upstream: routeConfig.upstream,
    timeoutMs: routeConfig.timeoutMs,
    thinking: routeConfig.thinking,
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
