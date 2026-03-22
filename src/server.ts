// ═══════════════════════════════════════════════════════════
// ClawBridge — HTTP Proxy Server
// ═══════════════════════════════════════════════════════════

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { getPort, isShadowMode, getAnthropicBaseUrl, getAnthropicApiKey, routingConfig, authConfig } from './config.js';
import { getProviderAuth, buildAuthHeaders } from './auth.js';
import { log, withRequestContext } from './logger.js';
import { route, extractUserText } from './router.js';
import { executeWithFallback } from './fallback.js';
import { estimateTokens } from './token_estimator.js';
import type { AnthropicRequestBody, Upstream, RouteExplanation } from './types.js';
import { recordUsage, extractTokensFromBody, calculateCost, getUsageSummary, getUsageRaw } from './usage.js';
import { getBudgetStatus, getRegretStats } from './budget.js';
import { detectRequiredCapabilities, getModelCapabilities } from './capabilities.js';
import { recordOutcome, getHealthStatus } from './health.js';
import { getAllRateLimitStatus } from './rate-limiter.js';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

// ── Body collector ──────────────────────────────────────────

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ── Passthrough proxy ───────────────────────────────────────

function passthrough(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  rawBody: string,
): void {
  const baseUrl = new URL(getAnthropicBaseUrl());
  const isHttps = baseUrl.protocol === 'https:';
  const requester = isHttps ? httpsRequest : httpRequest;

  const providerAuth = getProviderAuth('anthropic', authConfig);
  const upstreamAuthHeaders = providerAuth
    ? buildAuthHeaders(providerAuth)
    : { 'x-api-key': getAnthropicApiKey() };

  const headers: Record<string, string | string[] | undefined> = {
    ...clientReq.headers,
    host: baseUrl.hostname,
    ...upstreamAuthHeaders,
    'content-length': String(Buffer.byteLength(rawBody)),
  };

  const req = requester(
    {
      hostname: baseUrl.hostname,
      port: baseUrl.port || (isHttps ? 443 : 80),
      path: clientReq.url,
      method: clientReq.method,
      headers,
      timeout: 60000,
    },
    (res) => {
      clientRes.writeHead(res.statusCode || 502, res.headers);
      res.pipe(clientRes, { end: true });
    },
  );

  req.on('error', (err) => {
    log.error({ msg: 'passthrough_error', error: err.message });
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'passthrough_failed' }));
    }
  });

  req.write(rawBody);
  req.end();
}

// ── SSE wrapper (converts buffered JSON to Anthropic streaming format) ──

function sendAsSSE(res: ServerResponse, jsonBody: string): void {
  const msg = JSON.parse(jsonBody) as Record<string, unknown>;
  const content = msg.content as Array<Record<string, unknown>> | undefined;
  const text = content?.[0]?.text as string || '';
  const usage = msg.usage as Record<string, number> | undefined;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // message_start
  res.write(`event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: { id: msg.id, type: 'message', role: 'assistant', content: [], model: msg.model, stop_reason: null, usage: { input_tokens: usage?.input_tokens || 0, output_tokens: 0 } },
  })}\n\n`);

  // content_block_start
  res.write(`event: content_block_start\ndata: ${JSON.stringify({
    type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
  })}\n\n`);

  // content_block_delta (send full text in one delta)
  res.write(`event: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text },
  })}\n\n`);

  // content_block_stop
  res.write(`event: content_block_stop\ndata: ${JSON.stringify({
    type: 'content_block_stop', index: 0,
  })}\n\n`);

  // message_delta
  res.write(`event: message_delta\ndata: ${JSON.stringify({
    type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage?.output_tokens || 0 },
  })}\n\n`);

  // message_stop
  res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);

  res.end();
}

// ── Routing reason builder ──────────────────────────────────

function buildRoutingReason(decision: { category: string; model: string; upstream: string; decision_trace: { privacy_gate: boolean; budget_downgrade?: boolean; budget_original_model?: string; capability_upgrade?: boolean; capability_original_model?: string } }): string {
  const parts: string[] = [];

  if (decision.decision_trace.privacy_gate) {
    parts.push(`Privacy gate triggered → category ${decision.category}`);
  } else {
    parts.push(`Classified as "${decision.category}"`);
  }

  parts.push(`→ ${decision.upstream}/${decision.model}`);

  if (decision.decision_trace.capability_upgrade) {
    parts.push(`(upgraded from ${decision.decision_trace.capability_original_model} for capability requirements)`);
  }
  if (decision.decision_trace.budget_downgrade) {
    parts.push(`(downgraded from ${decision.decision_trace.budget_original_model} due to budget)`);
  }

  return parts.join(' ');
}

// ── Request handler ─────────────────────────────────────────

async function handleRequest(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
): Promise<void> {
  // Management endpoints
  if (clientReq.url === '/health' && clientReq.method === 'GET') {
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({
      status: 'ok',
      shadow: isShadowMode(),
      uptime: process.uptime(),
    }));
    return;
  }

  // ClawBridge models endpoint — lists all configured models across providers
  if (clientReq.url === '/v1/clawbridge/models' && clientReq.method === 'GET') {
    const seen = new Set<string>();
    const models: Array<{ model: string; upstream: string; categories: string[] }> = [];

    for (const [category, route] of Object.entries(routingConfig.routes)) {
      const key = `${route.model}@${route.upstream}`;
      if (seen.has(key)) {
        const existing = models.find(m => m.model === route.model && m.upstream === route.upstream);
        existing?.categories.push(category);
      } else {
        seen.add(key);
        models.push({ model: route.model, upstream: route.upstream, categories: [category] });
      }
    }

    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ models }, null, 2));
    return;
  }

  // Budget endpoints
  if (clientReq.url?.startsWith('/v1/clawbridge/budget/regret') && clientReq.method === 'GET') {
    const params = new URL(clientReq.url, 'http://localhost').searchParams;
    const stats = await getRegretStats(
      params.get('from') || undefined,
      params.get('to') || undefined,
    );
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify(stats, null, 2));
    return;
  }

  if (clientReq.url === '/v1/clawbridge/budget' && clientReq.method === 'GET') {
    const status = await getBudgetStatus();
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify(status, null, 2));
    return;
  }

  // Rate limits endpoint
  if (clientReq.url === '/v1/clawbridge/rate-limits' && clientReq.method === 'GET') {
    const status = await getAllRateLimitStatus();
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify(status, null, 2));
    return;
  }

  // Health endpoint — SLO scores and dynamic fallback order
  if (clientReq.url === '/v1/clawbridge/health' && clientReq.method === 'GET') {
    const status = getHealthStatus(routingConfig.fallback_chain);
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify(status, null, 2));
    return;
  }

  // Route explain endpoint — dry-run routing for a request body
  if (clientReq.url === '/v1/clawbridge/route/explain' && clientReq.method === 'POST') {
    let body: AnthropicRequestBody;
    try {
      const raw = await collectBody(clientReq);
      body = JSON.parse(raw) as AnthropicRequestBody;
    } catch {
      clientRes.writeHead(400, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'invalid_json' }));
      return;
    }

    const decision = await route(body);
    const { lastText } = extractUserText(body);
    const requiredCaps = detectRequiredCapabilities(body, lastText);
    const modelCaps = getModelCapabilities(decision.model);

    const hasImages = (body.messages || []).some(m => {
      if (!Array.isArray(m.content)) return false;
      return m.content.some(b => b.type === 'image' || b.type === 'image_url');
    });

    const lastMsg = (body.messages || []).filter(m => m.role === 'user').slice(-1)[0];
    const preview = lastMsg
      ? (typeof lastMsg.content === 'string'
          ? lastMsg.content.slice(0, 100)
          : Array.isArray(lastMsg.content)
            ? lastMsg.content.filter(b => b.type === 'text').map(b => b.text || '').join(' ').slice(0, 100)
            : '')
      : '';

    const explanation: RouteExplanation = {
      input_summary: {
        last_message_preview: preview + (preview.length >= 100 ? '...' : ''),
        message_count: (body.messages || []).length,
        has_tools: !!(body.tools && body.tools.length > 0),
        has_images: hasImages,
        estimated_tokens: estimateTokens(lastText),
      },
      classification: {
        category: decision.category,
        confidence: decision.confidence,
        rules_hit: decision.decision_trace.rules_hit,
        privacy_detected: decision.decision_trace.privacy_gate,
      },
      routing: {
        model: decision.model,
        upstream: decision.upstream,
        reason: buildRoutingReason(decision),
      },
      capabilities: {
        required: requiredCaps,
        model_has: modelCaps?.capabilities || [],
        upgrade_applied: decision.decision_trace.capability_upgrade || false,
        upgrade_reason: decision.decision_trace.capability_missing
          ? `Missing: ${decision.decision_trace.capability_missing.join(', ')}`
          : undefined,
      },
      budget: {
        level: decision.decision_trace.budget_level || 'normal',
        downgrade_applied: decision.decision_trace.budget_downgrade || false,
        original_model: decision.decision_trace.budget_original_model,
      },
      fallback_chain: decision.fallback_chain.map(s => ({ model: s.model, upstream: s.upstream })),
    };

    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify(explanation, null, 2));
    return;
  }

  // Usage tracking endpoints
  if (clientReq.url?.startsWith('/v1/clawbridge/usage/raw') && clientReq.method === 'GET') {
    const params = new URL(clientReq.url, 'http://localhost').searchParams;
    const records = await getUsageRaw({
      limit: params.get('limit') ? parseInt(params.get('limit')!, 10) : 100,
      model: params.get('model') || undefined,
      category: params.get('category') || undefined,
      from: params.get('from') || undefined,
      to: params.get('to') || undefined,
    });
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ count: records.length, records }, null, 2));
    return;
  }

  if (clientReq.url?.startsWith('/v1/clawbridge/usage') && clientReq.method === 'GET') {
    const params = new URL(clientReq.url, 'http://localhost').searchParams;
    const summary = await getUsageSummary({
      from: params.get('from') || undefined,
      to: params.get('to') || undefined,
    });
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify(summary, null, 2));
    return;
  }

  // Non-message requests → passthrough to Anthropic
  if (clientReq.method !== 'POST' || !clientReq.url?.startsWith('/v1/messages')) {
    const raw = await collectBody(clientReq);
    passthrough(clientReq, clientRes, raw);
    return;
  }

  // ── Main routing path: POST /v1/messages ──────────────────

  const requestId = randomUUID();
  const startTime = Date.now();

  await withRequestContext(requestId, async () => {
    let body: AnthropicRequestBody;
    try {
      const raw = await collectBody(clientReq);
      body = JSON.parse(raw) as AnthropicRequestBody;
    } catch {
      clientRes.writeHead(400, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'invalid_json' }));
      return;
    }

    const clientWantsStream = body.stream === true;

    // Route (classify without modifying the body)
    const decision = await route(body);

    // Log the routing decision
    const userText = (body.messages || [])
      .filter(m => m.role === 'user')
      .map(m => {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) {
          return m.content
            .filter((b: Record<string, unknown>) => b.type === 'text')
            .map((b: Record<string, unknown>) => b.text as string)
            .join(' ');
        }
        return '';
      })
      .join(' ');

    log.info({
      msg: 'route_decision',
      request_id: requestId,
      category: decision.category,
      model: decision.model,
      upstream: decision.upstream,
      confidence: decision.confidence,
      streaming: clientWantsStream,
    });

    // Shadow mode: log decision but passthrough to Anthropic
    if (isShadowMode()) {
      passthrough(clientReq, clientRes, JSON.stringify(body));
      return;
    }

    // Anthropic upstream: pipe directly (preserves streaming)
    if (decision.upstream === 'anthropic') {
      const pipeBody = { ...body, model: decision.model };
      passthrough(clientReq, clientRes, JSON.stringify(pipeBody));
      const pipedLatency = Date.now() - startTime;
      log.info({
        msg: 'request_complete',
        request_id: requestId,
        category: decision.category,
        primary_model: decision.model,
        final_model: decision.model,
        latency_ms: pipedLatency,
        piped: true,
      });
      // Record health outcome (piped = assume success)
      recordOutcome(decision.model, decision.upstream, true, pipedLatency);

      const estimatedIn = estimateTokens(userText);
      const pipedCost = calculateCost(decision.model, estimatedIn, 0);
      recordUsage({
        ts: new Date().toISOString(),
        request_id: requestId,
        category: decision.category,
        upstream: decision.upstream,
        model: decision.model,
        primary_model: decision.model,
        fallback_used: false,
        latency_ms: pipedLatency,
        input_tokens: estimatedIn,
        output_tokens: 0,
        token_source: 'estimate',
        ...pipedCost,
        piped: true,
        budget_downgraded: decision.decision_trace.budget_downgrade || false,
      });
      return;
    }

    // Non-Anthropic upstream (Google, Ollama): buffer mode, no streaming
    body.stream = false;

    // Execute with fallback
    const fallbackResult = await executeWithFallback(clientReq, clientRes, body, decision);

    const latencyMs = Date.now() - startTime;

    log.info({
      msg: 'request_complete',
      request_id: requestId,
      category: decision.category,
      confidence: decision.confidence,
      primary_model: decision.model,
      final_model: fallbackResult.finalModel,
      fallback_used: fallbackResult.fallbackUsed,
      fallback_steps: fallbackResult.attempts.length - 1,
      latency_ms: latencyMs,
      token_estimate_in: estimateTokens(userText),
      decision_trace: decision.decision_trace,
    });

    // Record health outcome for the final model used
    recordOutcome(
      fallbackResult.finalModel,
      fallbackResult.finalUpstream,
      fallbackResult.result.ok,
      latencyMs,
      fallbackResult.result.ok ? undefined : fallbackResult.result.error,
    );

    // Record usage with actual tokens from response
    const tokens = fallbackResult.result.ok
      ? extractTokensFromBody(fallbackResult.result.body)
      : { input_tokens: estimateTokens(userText), output_tokens: 0 };
    const tokenSource = fallbackResult.result.ok ? 'actual' as const : 'estimate' as const;
    const cost = calculateCost(fallbackResult.finalModel, tokens.input_tokens, tokens.output_tokens);
    recordUsage({
      ts: new Date().toISOString(),
      request_id: requestId,
      category: decision.category,
      upstream: fallbackResult.finalUpstream as Upstream,
      model: fallbackResult.finalModel,
      primary_model: decision.model,
      fallback_used: fallbackResult.fallbackUsed,
      latency_ms: latencyMs,
      input_tokens: tokens.input_tokens,
      output_tokens: tokens.output_tokens,
      token_source: tokenSource,
      ...cost,
      piped: false,
      budget_downgraded: decision.decision_trace.budget_downgrade || false,
    });

    // Send response
    if (!clientRes.headersSent) {
      if (fallbackResult.result.ok) {
        if (clientWantsStream) {
          // Convert buffered response to Anthropic SSE format
          sendAsSSE(clientRes, fallbackResult.result.body || '{}');
        } else {
          clientRes.writeHead(200, { 'Content-Type': 'application/json' });
          clientRes.end(fallbackResult.result.body);
        }
      } else {
        const status = fallbackResult.result.status || 502;
        clientRes.writeHead(status, { 'Content-Type': 'application/json' });
        clientRes.end(fallbackResult.result.body || JSON.stringify({
          error: fallbackResult.result.error,
          attempts: fallbackResult.attempts,
        }));
      }
    }
  });
}

// ── Server startup ──────────────────────────────────────────

const port = getPort();
const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    log.error({ msg: 'unhandled_error', error: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_server_error' }));
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  log.info({
    msg: 'clawbridge_started',
    port,
    shadow: isShadowMode(),
  });
});

// Graceful shutdown
function shutdown(signal: string): void {
  log.info({ msg: 'shutting_down', signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
