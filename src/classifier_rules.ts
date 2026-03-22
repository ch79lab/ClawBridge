// ═══════════════════════════════════════════════════════════
// ClawBridge — Rules-Based Classifier (v2 — Short-Circuit)
// ═══════════════════════════════════════════════════════════

import type { Category, ClassifierResult, RoutingConfig, AnthropicRequestBody } from './types.js';
import { estimateTokens } from './token_estimator.js';

// ── Privacy Gate ────────────────────────────────────────────

function checkPrivacyGate(
  message: string,
  config: RoutingConfig,
): { isPrivate: boolean; reason?: string } {
  const lower = message.toLowerCase();

  for (const keyword of config.privacy.keywords) {
    if (lower.includes(keyword.toLowerCase())) {
      return { isPrivate: true, reason: `keyword:"${keyword}"` };
    }
  }

  for (const pattern of config.privacy.pii_regexes) {
    try {
      const re = new RegExp(pattern);
      if (re.test(message)) {
        return { isPrivate: true, reason: `pii_pattern` };
      }
    } catch { /* skip */ }
  }

  for (const pattern of config.privacy.sensitive_patterns) {
    try {
      const re = new RegExp(pattern, 'i');
      if (re.test(message)) {
        return { isPrivate: true, reason: `sensitive_pattern` };
      }
    } catch { /* skip */ }
  }

  return { isPrivate: false };
}

function isComplexPrivate(message: string, config: RoutingConfig): boolean {
  const lower = message.toLowerCase();
  return config.privacy.complexity_keywords.some(kw =>
    lower.includes(kw.toLowerCase()),
  );
}

// ── Detection helpers ───────────────────────────────────────

function hasImages(body: AnthropicRequestBody): boolean {
  return (body.messages || []).some(m => {
    if (!Array.isArray(m.content)) return false;
    return m.content.some(b => b.type === 'image' || b.type === 'image_url');
  });
}

function hasToolCall(body: AnthropicRequestBody): boolean {
  return !!(body.tools && body.tools.length > 0);
}

function hasCodeBlocks(text: string): boolean {
  return /```[\s\S]*?```/.test(text);
}

const FILE_EXTENSIONS = /\.(ts|js|py|go|rs|java|rb|php|c|cpp|h|css|html|json|yaml|yml|toml|sh|bash|sql|md|tsx|jsx)\b/i;

function hasFileReferences(text: string): boolean {
  return FILE_EXTENSIONS.test(text);
}

// ── Keyword counting ────────────────────────────────────────

function countHits(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.reduce(
    (count, kw) => count + (lower.includes(kw.toLowerCase()) ? 1 : 0),
    0,
  );
}

// ── Domain detection ────────────────────────────────────────

type Domain = 'code' | 'analysis' | 'reasoning' | 'action' | 'none';

function detectDomain(lastText: string, config: RoutingConfig): { domain: Domain; hits: number } {
  const codeKeywords = config.rules.code || [];
  const analysisKeywords = config.rules.analysis || [];
  const actionKeywords = config.rules.action || [];
  // Use dedicated reasoning rules (not privacy.complexity_keywords which is for private_simple/complex)
  const reasoningKeywords = config.rules.reasoning || config.privacy.complexity_keywords || [];

  const codeHits = countHits(lastText, codeKeywords)
    + (hasCodeBlocks(lastText) ? 2 : 0)
    + (hasFileReferences(lastText) ? 1 : 0);
  const analysisHits = countHits(lastText, analysisKeywords);
  const actionHits = countHits(lastText, actionKeywords);
  const reasoningHits = countHits(lastText, reasoningKeywords);

  // Find max hits across all domains
  const maxHits = Math.max(codeHits, analysisHits, actionHits, reasoningHits);
  if (maxHits === 0) return { domain: 'none', hits: 0 };

  // Highest score wins. On tie priority: code > analysis > action > reasoning (cost-optimized)
  if (codeHits === maxHits) return { domain: 'code', hits: codeHits };
  if (analysisHits === maxHits) return { domain: 'analysis', hits: analysisHits };
  if (actionHits === maxHits) return { domain: 'action', hits: actionHits };
  return { domain: 'reasoning', hits: reasoningHits };
}

// ── Legacy scoring (for batch/action/complex fallback) ──────

interface CategoryScore {
  category: Category;
  hits: number;
  total: number;
  score: number;
}

function scoreCategories(
  message: string,
  config: RoutingConfig,
): CategoryScore[] {
  const scorable: Array<{ key: string; category: Category }> = [
    { key: 'complex', category: 'complex' },
    { key: 'analysis', category: 'analysis' },
    { key: 'action', category: 'action' },
    { key: 'batch', category: 'batch' },
  ];

  return scorable.map(({ key, category }) => {
    const keywords = config.rules[key] || [];
    const hits = countHits(message, keywords);
    const total = keywords.length;
    const score = total > 0 ? hits / total : 0;
    return { category, hits, total, score };
  });
}

// ── Main classifier (v2 — short-circuit) ────────────────────

const TOKEN_THRESHOLD = 500; // TEMP: lowered from 50000 to test OpenAI OAuth routing

/**
 * Classify using short-circuit evaluation order:
 * 1. Privacy gate → private_simple/private_complex
 * 2. Image in payload → vision
 * 3. Batch keywords → batch
 * 4. Tool call in payload → action
 * 5. Domain + complexity → code/deep_analysis/complex/analysis/default
 */
export function classifyByRules(
  recentText: string,
  lastText: string,
  config: RoutingConfig,
  body?: AnthropicRequestBody,
): ClassifierResult {
  const rules_hit: string[] = [];
  const estimatedTokens = estimateTokens(lastText);

  // ── Step 1: Privacy gate ──
  // Keywords: check only lastText (current message intent, not conversation history)
  // PII regexes + sensitive patterns: check lastText only (actual data in current message)
  const privacy = checkPrivacyGate(lastText, config);
  if (privacy.isPrivate) {
    const isComplex = isComplexPrivate(lastText, config);
    const category: Category = isComplex ? 'private_complex' : 'private_simple';
    rules_hit.push(`privacy_gate:${privacy.reason}`);
    if (isComplex) rules_hit.push('private_complexity:complex');
    return { category, confidence: 1.0, rules_hit };
  }

  // ── Step 2: Image detection → vision ──
  if (body && hasImages(body)) {
    rules_hit.push('image_detected');
    return { category: 'vision', confidence: 0.95, rules_hit };
  }

  // ── Step 3: Batch detection ──
  const batchKeywords = config.rules.batch || [];
  const batchHits = countHits(lastText, batchKeywords);
  if (batchHits >= 2) {
    rules_hit.push(`batch_hits:${batchHits}`);
    return { category: 'batch', confidence: 0.85, rules_hit };
  }

  // ── Step 4: Tool call detection → action ──
  // NOTE: Skipped. OpenClaw sends tools[] in every request as "available capabilities",
  // not as explicit tool-use intent. Routing by tools presence would classify everything
  // as "action". Tool-use capability is handled by the capability-aware upgrade system instead.

  // ── Step 5: Domain + complexity classification ──
  const { domain, hits: domainHits } = detectDomain(lastText, config);
  rules_hit.push(`domain:${domain}(${domainHits})`);

  if (domain === 'code') {
    if (estimatedTokens > TOKEN_THRESHOLD) {
      rules_hit.push(`tokens:${estimatedTokens}>threshold`);
      return { category: 'code', confidence: 0.90, rules_hit };
    }
    // Code domain but under threshold → complex (Sonnet)
    return { category: 'complex', confidence: 0.80, rules_hit };
  }

  if (domain === 'analysis') {
    if (estimatedTokens > TOKEN_THRESHOLD) {
      rules_hit.push(`tokens:${estimatedTokens}>threshold`);
      return { category: 'deep_analysis', confidence: 0.90, rules_hit };
    }
    return { category: 'analysis', confidence: 0.80, rules_hit };
  }

  if (domain === 'action') {
    return { category: 'action', confidence: 0.75, rules_hit };
  }

  if (domain === 'reasoning') {
    return { category: 'complex', confidence: 0.75, rules_hit };
  }

  // ── Fallback: legacy scoring for ambiguous cases ──
  const scores = scoreCategories(lastText, config);
  const totalHits = scores.reduce((sum, s) => sum + s.hits, 0);

  if (totalHits === 0) {
    rules_hit.push('no_keyword_hits');
    return { category: 'default', confidence: 0.3, rules_hit };
  }

  scores.sort((a, b) => b.score - a.score || b.hits - a.hits);
  const best = scores[0];
  const second = scores[1];

  let confidence = best.hits / totalHits;
  if (second && second.hits > 0 && best.hits >= second.hits * 2) {
    confidence = Math.min(1.0, confidence + 0.15);
  }
  if (totalHits <= 1) {
    confidence = Math.min(confidence, 0.5);
  }

  rules_hit.push(`scores:${scores.map(s => `${s.category}=${s.hits}`).join(',')}`);

  return {
    category: best.category,
    confidence: Math.round(confidence * 100) / 100,
    rules_hit,
  };
}
