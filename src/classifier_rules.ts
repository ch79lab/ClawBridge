// ═══════════════════════════════════════════════════════════
// ClawBridge — Rules-Based Classifier
// ═══════════════════════════════════════════════════════════

import type { Category, ClassifierResult, RoutingConfig } from './types.js';

// ── Privacy Gate ────────────────────────────────────────────

function checkPrivacyGate(
  message: string,
  config: RoutingConfig,
): { isPrivate: boolean; reason?: string } {
  const lower = message.toLowerCase();

  // Check privacy keywords
  for (const keyword of config.privacy.keywords) {
    if (lower.includes(keyword.toLowerCase())) {
      return { isPrivate: true, reason: `keyword:"${keyword}"` };
    }
  }

  // Check PII regexes
  for (const pattern of config.privacy.pii_regexes) {
    try {
      const re = new RegExp(pattern);
      if (re.test(message)) {
        return { isPrivate: true, reason: `pii_pattern` };
      }
    } catch {
      // Invalid regex — skip
    }
  }

  // Check sensitive patterns (API keys, tokens, SSH keys)
  for (const pattern of config.privacy.sensitive_patterns) {
    try {
      const re = new RegExp(pattern, 'i');
      if (re.test(message)) {
        return { isPrivate: true, reason: `sensitive_pattern` };
      }
    } catch {
      // Invalid regex — skip
    }
  }

  return { isPrivate: false };
}

function isComplexPrivate(message: string, config: RoutingConfig): boolean {
  const lower = message.toLowerCase();
  return config.privacy.complexity_keywords.some(kw =>
    lower.includes(kw.toLowerCase()),
  );
}

// ── Category Scoring ────────────────────────────────────────

function countHits(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.reduce(
    (count, kw) => count + (lower.includes(kw.toLowerCase()) ? 1 : 0),
    0,
  );
}

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
  const categories: Array<{ key: keyof typeof config.rules; category: Category }> = [
    { key: 'complex', category: 'complex' },
    { key: 'analysis', category: 'analysis' },
    { key: 'action', category: 'action' },
    { key: 'batch', category: 'batch' },
  ];

  return categories.map(({ key, category }) => {
    const keywords = config.rules[key];
    const hits = countHits(message, keywords);
    const total = keywords.length;
    const score = total > 0 ? hits / total : 0;
    return { category, hits, total, score };
  });
}

// ── Main classifier ─────────────────────────────────────────

/**
 * Classify a message using keyword rules.
 * @param recentText - Last 3 user messages (for privacy gate — broader context)
 * @param lastText - Last user message only (for category scoring — current intent)
 * @param config - Routing configuration
 */
export function classifyByRules(
  recentText: string,
  lastText: string,
  config: RoutingConfig,
): ClassifierResult {
  const rules_hit: string[] = [];

  // Step 1: Privacy gate checks recent context (last 3 messages)
  const privacy = checkPrivacyGate(recentText, config);
  if (privacy.isPrivate) {
    const isComplex = isComplexPrivate(lastText, config);
    const category: Category = isComplex ? 'private_complex' : 'private_simple';
    rules_hit.push(`privacy_gate:${privacy.reason}`);
    if (isComplex) rules_hit.push('private_complexity:complex');
    return { category, confidence: 1.0, rules_hit };
  }

  // Step 2: Category scoring (only the current message)
  const scores = scoreCategories(lastText, config);
  const totalHits = scores.reduce((sum, s) => sum + s.hits, 0);

  // No hits at all — low confidence, default to action
  if (totalHits === 0) {
    rules_hit.push('no_keyword_hits');
    return { category: 'action', confidence: 0.3, rules_hit };
  }

  // Sort by score descending, then by hits descending for tiebreak
  scores.sort((a, b) => b.score - a.score || b.hits - a.hits);

  const best = scores[0];
  const second = scores[1];

  // Confidence: ratio of best to total, boosted by absolute hits
  let confidence = best.hits / totalHits;
  // Boost confidence if there's a clear winner (>2x the second)
  if (second && second.hits > 0 && best.hits >= second.hits * 2) {
    confidence = Math.min(1.0, confidence + 0.15);
  }
  // Reduce confidence if very few hits overall
  if (totalHits <= 1) {
    confidence = Math.min(confidence, 0.5);
  }

  rules_hit.push(
    `scores:${scores.map(s => `${s.category}=${s.hits}`).join(',')}`,
  );

  return {
    category: best.category,
    confidence: Math.round(confidence * 100) / 100,
    rules_hit,
  };
}
