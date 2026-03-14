// ═══════════════════════════════════════════════════════════
// ClawBridge — HTTP Proxy Server
// ═══════════════════════════════════════════════════════════

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { getPort, isShadowMode, getAnthropicBaseUrl, getAnthropicApiKey } from './config.js';
import { log, withRequestContext } from './logger.js';
import { route } from './router.js';
import { executeWithFallback } from './fallback.js';
import { estimateTokens } from './token_estimator.js';
import type { AnthropicRequestBody } from './types.js';
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

  const headers: Record<string, string | string[] | undefined> = {
    ...clientReq.headers,
    host: baseUrl.hostname,
    'x-api-key': getAnthropicApiKey(),
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
      .map(m => typeof m.content === 'string' ? m.content : '')
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
      log.info({
        msg: 'request_complete',
        request_id: requestId,
        category: decision.category,
        primary_model: decision.model,
        final_model: decision.model,
        latency_ms: Date.now() - startTime,
        piped: true,
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

    // Send response
    if (!clientRes.headersSent) {
      if (fallbackResult.result.ok) {
        clientRes.writeHead(200, { 'Content-Type': 'application/json' });
        clientRes.end(fallbackResult.result.body);
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
