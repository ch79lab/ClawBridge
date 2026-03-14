// ═══════════════════════════════════════════════════════════
// ClawBridge — Fallback Chain
// ═══════════════════════════════════════════════════════════

import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from './logger.js';
import { proxyToAnthropic, proxyToGoogle, proxyToOllama } from './upstream.js';
import type { AnthropicRequestBody, FallbackStep, RoutingDecision, UpstreamResult } from './types.js';

export interface FallbackResult {
  result: UpstreamResult;
  finalModel: string;
  finalUpstream: string;
  fallbackUsed: boolean;
  attempts: string[];
}

async function callUpstream(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  body: AnthropicRequestBody,
  model: string,
  upstream: string,
  timeoutMs: number,
  thinking: boolean,
  maxSystemChars?: number,
): Promise<UpstreamResult> {
  switch (upstream) {
    case 'ollama':
      return proxyToOllama(body, model, thinking, timeoutMs, maxSystemChars);
    case 'google':
      return proxyToGoogle(body, model, timeoutMs);
    case 'anthropic':
      return proxyToAnthropic(clientReq, clientRes, body, model, timeoutMs);
    default:
      return { ok: false, error: `unknown upstream: ${upstream}` };
  }
}

function isRetryable(result: UpstreamResult): boolean {
  if (!result.ok) {
    // 4xx (except 429) are client errors — don't retry
    if (result.status && result.status >= 400 && result.status < 500 && result.status !== 429) {
      return false;
    }
    return true;
  }
  return false;
}

export async function executeWithFallback(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  body: AnthropicRequestBody,
  decision: RoutingDecision,
): Promise<FallbackResult> {
  const attempts: string[] = [];

  // Truncate system prompt for simple private requests to reduce Ollama latency
  const maxSystemChars = decision.category === 'private_simple' ? 512 : undefined;

  // Build the full chain: primary + fallback steps
  const chain: Array<{ model: string; upstream: string; timeoutMs: number; thinking: boolean }> = [
    {
      model: decision.model,
      upstream: decision.upstream,
      timeoutMs: decision.timeoutMs,
      thinking: decision.thinking,
    },
    ...decision.fallback_chain.map((step: FallbackStep) => ({
      ...step,
      thinking: step.upstream === 'ollama' && decision.thinking,
    })),
  ];

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];
    const isPrimary = i === 0;
    const isLocal = step.upstream === 'ollama';

    // Cloud gets 1 retry for transient errors; local gets 0
    const maxTries = isLocal ? 1 : 2;

    for (let attempt = 0; attempt < maxTries; attempt++) {
      const label = `${step.upstream}/${step.model}${attempt > 0 ? ' (retry)' : ''}`;

      try {
        const result = await callUpstream(
          clientReq,
          clientRes,
          body,
          step.model,
          step.upstream,
          step.timeoutMs,
          step.thinking,
          step.upstream === 'ollama' ? maxSystemChars : undefined,
        );

        if (result.ok) {
          attempts.push(`${label}: ok`);
          return {
            result,
            finalModel: step.model,
            finalUpstream: step.upstream,
            fallbackUsed: !isPrimary,
            attempts,
          };
        }

        attempts.push(`${label}: ${result.error || `status ${result.status}`}`);

        if (!isRetryable(result)) {
          // 4xx client error — don't retry or fallback
          log.warn({
            msg: 'client_error_no_retry',
            model: step.model,
            upstream: step.upstream,
            status: result.status,
          });
          return {
            result,
            finalModel: step.model,
            finalUpstream: step.upstream,
            fallbackUsed: !isPrimary,
            attempts,
          };
        }

        log.warn({
          msg: 'upstream_failed',
          model: step.model,
          upstream: step.upstream,
          error: result.error,
          status: result.status,
          attempt: attempt + 1,
          maxTries,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        attempts.push(`${label}: exception ${errMsg}`);
        log.error({
          msg: 'upstream_exception',
          model: step.model,
          upstream: step.upstream,
          error: errMsg,
        });
      }
    }
  }

  // All fallbacks exhausted
  log.error({ msg: 'all_upstreams_failed', attempts });
  return {
    result: { ok: false, status: 502, error: 'all_upstreams_failed', body: JSON.stringify({ error: 'all_upstreams_failed', attempts }) },
    finalModel: chain[chain.length - 1].model,
    finalUpstream: chain[chain.length - 1].upstream,
    fallbackUsed: true,
    attempts,
  };
}
