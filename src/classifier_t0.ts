// ═══════════════════════════════════════════════════════════
// ClawBridge — T0 LLM Classifier (Ollama/Qwen)
// ═══════════════════════════════════════════════════════════

import { getOllamaUrl } from './config.js';
import { log } from './logger.js';
import type { Category, ClassifierResult } from './types.js';
import { CATEGORIES } from './types.js';

const T0_PROMPT = `You are a strict task classifier.

Return exactly ONE label from this list:
complex
analysis
action
batch
private_simple
private_complex

Definitions:
- complex: high ambiguity, decision-making, architecture, trade-offs, strategy
- analysis: summarization, comparison, synthesis, structuring, reading comprehension
- action: rewriting, formatting, transforming content, short execution-oriented tasks
- batch: extraction, classification, parsing, repetitive processing
- private_simple: sensitive/internal content with low ambiguity
- private_complex: sensitive/internal content requiring reasoning or recommendations

Rules:
- If user asks not to send to cloud, choose private_simple or private_complex.
- If sensitive AND asks for recommendation/risks/decision, choose private_complex.
- Output ONLY the label. No punctuation. No explanation.`;

// All categories — T0 may detect privacy that rules missed
const VALID_T0_CATEGORIES: readonly Category[] = CATEGORIES;

export async function classifyByT0(
  message: string,
  fallbackResult: ClassifierResult,
  t0Model: string,
  t0TimeoutMs: number,
): Promise<ClassifierResult> {
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), t0TimeoutMs);

    const response = await fetch(`${getOllamaUrl()}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: t0Model,
        prompt: `${T0_PROMPT}\n\nMessage: ${message.slice(0, 1024)}`,
        stream: false,
        think: false,
        options: {
          temperature: 0,
          num_predict: 20,
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      log.warn({
        msg: 't0_classifier_http_error',
        status: response.status,
        latency_ms: Date.now() - start,
      });
      return { ...fallbackResult, rules_hit: [...fallbackResult.rules_hit, 't0:http_error'] };
    }

    const data = (await response.json()) as { response?: string };
    const raw = (data.response || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
    const latency = Date.now() - start;

    // Validate against known categories
    const matched = CATEGORIES.find(c => raw === c || raw.startsWith(c));
    if (matched) {
      log.info({ msg: 't0_classified', category: matched, raw, latency_ms: latency });
      return {
        category: matched,
        confidence: 0.85,
        rules_hit: [...fallbackResult.rules_hit, `t0:${matched}`, `t0_latency:${latency}ms`],
      };
    }

    // Unparseable — use rules fallback
    log.warn({ msg: 't0_unparseable', raw, latency_ms: latency });
    return {
      ...fallbackResult,
      rules_hit: [...fallbackResult.rules_hit, `t0:unparseable(${raw})`],
    };
  } catch (err) {
    const latency = Date.now() - start;
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn({ msg: 't0_classifier_error', error: errMsg, latency_ms: latency });
    return {
      ...fallbackResult,
      rules_hit: [...fallbackResult.rules_hit, `t0:error(${errMsg})`],
    };
  }
}
