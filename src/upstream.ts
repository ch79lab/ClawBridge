// ═══════════════════════════════════════════════════════════
// ClawBridge — Upstream Proxy (Protocol Translation)
// ═══════════════════════════════════════════════════════════

import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { getAnthropicApiKey, getAnthropicBaseUrl, getGoogleApiKey, getOllamaUrl, hasGoogleApiKey, authConfig } from './config.js';
import { getProviderAuth, buildAuthHeaders, buildAuthUrlParam } from './auth.js';
import { log } from './logger.js';
import type { AnthropicRequestBody, UpstreamResult } from './types.js';

// ── Ollama Protocol Translation ─────────────────────────────

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function toOllamaBody(
  body: AnthropicRequestBody,
  model: string,
  thinking: boolean,
): Record<string, unknown> {
  const messages: OllamaChatMessage[] = [];

  // System message
  if (body.system) {
    const systemText = typeof body.system === 'string'
      ? body.system
      : JSON.stringify(body.system);

    messages.push({ role: 'system', content: systemText });
  }

  // Convert messages
  for (const m of body.messages || []) {
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
    const content = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter(b => b.type === 'text').map(b => b.text || '').join('\n')
        : JSON.stringify(m.content);
    messages.push({ role, content });
  }

  return {
    model,
    messages,
    stream: false,
    think: thinking,
  };
}

function fromOllamaResponse(
  data: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const message = data.message as Record<string, unknown> | undefined;
  const responseText = (message?.content as string) || (data.response as string) || '';

  return {
    id: `msg_local_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: `ollama/${model}`,
    content: [{ type: 'text', text: responseText }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: (data.prompt_eval_count as number) || 0,
      output_tokens: (data.eval_count as number) || 0,
    },
  };
}

// ── Google Gemini Protocol Translation ──────────────────────

function toGeminiBody(body: AnthropicRequestBody): Record<string, unknown> {
  const contents: Array<Record<string, unknown>> = [];

  for (const m of body.messages || []) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    let text: string;
    if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
    } else {
      text = JSON.stringify(m.content);
    }
    contents.push({ role, parts: [{ text }] });
  }

  const result: Record<string, unknown> = { contents };

  // System instruction
  if (body.system) {
    const systemText = typeof body.system === 'string'
      ? body.system
      : JSON.stringify(body.system);
    result.systemInstruction = { parts: [{ text: systemText }] };
  }

  // Generation config
  result.generationConfig = {
    maxOutputTokens: body.max_tokens || 4096,
    temperature: body.temperature,
  };

  return result;
}

function fromGeminiResponse(
  data: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const candidates = data.candidates as Array<Record<string, unknown>> | undefined;
  let text = '';

  if (candidates && candidates.length > 0) {
    const content = candidates[0].content as Record<string, unknown> | undefined;
    const parts = content?.parts as Array<Record<string, unknown>> | undefined;
    if (parts && parts.length > 0) {
      text = (parts[0].text as string) || '';
    }
  }

  const usageMetadata = data.usageMetadata as Record<string, number> | undefined;

  return {
    id: `msg_google_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: `google/${model}`,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: usageMetadata?.promptTokenCount || 0,
      output_tokens: usageMetadata?.candidatesTokenCount || 0,
    },
  };
}

// ── OpenAI Chat Completions Protocol Translation ────────────

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'developer';
  content: string | Array<Record<string, unknown>>;
}

export function toOpenAIBody(body: AnthropicRequestBody, model: string): Record<string, unknown> {
  const messages: OpenAIChatMessage[] = [];

  // System message → first message with role "system"
  if (body.system) {
    const systemText = typeof body.system === 'string'
      ? body.system
      : JSON.stringify(body.system);
    messages.push({ role: 'system', content: systemText });
  }

  // Convert messages
  for (const m of body.messages || []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';

    if (typeof m.content === 'string') {
      messages.push({ role, content: m.content });
    } else if (Array.isArray(m.content)) {
      // Check for image blocks (vision)
      const hasImages = m.content.some(b => b.type === 'image' || b.type === 'image_url');

      if (hasImages) {
        // OpenAI vision format: array of content parts
        const parts: Array<Record<string, unknown>> = [];
        for (const block of m.content) {
          if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text || '' });
          } else if (block.type === 'image') {
            // Anthropic base64 image → OpenAI image_url
            const source = block.source as Record<string, string> | undefined;
            if (source?.type === 'base64') {
              parts.push({
                type: 'image_url',
                image_url: { url: `data:${source.media_type};base64,${source.data}` },
              });
            }
          } else if (block.type === 'image_url') {
            parts.push(block);
          }
        }
        messages.push({ role, content: parts });
      } else {
        // Text-only: concatenate
        const text = m.content
          .filter(b => b.type === 'text')
          .map(b => b.text || '')
          .join('\n');
        messages.push({ role, content: text });
      }
    }
  }

  const result: Record<string, unknown> = {
    model,
    messages,
    stream: false,
  };

  if (body.max_tokens) result.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) result.temperature = body.temperature;

  // Tool use translation: Anthropic → OpenAI format
  if (body.tools && body.tools.length > 0) {
    result.tools = (body.tools as Array<Record<string, unknown>>).map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  return result;
}

export function fromOpenAIResponse(
  data: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  let text = '';

  if (choices && choices.length > 0) {
    const message = choices[0].message as Record<string, unknown> | undefined;
    text = (message?.content as string) || '';
  }

  const usage = data.usage as Record<string, number> | undefined;

  // Map finish_reason to stop_reason
  const finishReason = choices?.[0]?.finish_reason as string | undefined;
  const stopReason = finishReason === 'stop' ? 'end_turn'
    : finishReason === 'length' ? 'max_tokens'
    : finishReason === 'tool_calls' ? 'tool_use'
    : 'end_turn';

  return {
    id: `msg_openai_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: `openai/${model}`,
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    usage: {
      input_tokens: usage?.prompt_tokens || 0,
      output_tokens: usage?.completion_tokens || 0,
    },
  };
}

// ── Proxy Functions ─────────────────────────────────────────

export async function proxyToOllama(
  body: AnthropicRequestBody,
  model: string,
  thinking: boolean,
  timeoutMs: number,
): Promise<UpstreamResult> {
  const ollamaUrl = getOllamaUrl();
  const payload = JSON.stringify(toOllamaBody(body, model, thinking));

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errBody = await response.text();
      return { ok: false, status: response.status, body: errBody, error: `ollama ${response.status}` };
    }

    const raw = await response.json() as Record<string, unknown>;
    const anthropicResponse = fromOllamaResponse(raw, model);
    return { ok: true, status: 200, body: JSON.stringify(anthropicResponse) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export async function proxyToGoogle(
  body: AnthropicRequestBody,
  model: string,
  timeoutMs: number,
): Promise<UpstreamResult> {
  const providerAuth = getProviderAuth('google', authConfig);
  let url: string;
  if (providerAuth) {
    const urlParam = buildAuthUrlParam(providerAuth);
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?${urlParam}`;
  } else {
    if (!hasGoogleApiKey()) {
      return { ok: false, error: 'GOOGLE_API_KEY not configured' };
    }
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${getGoogleApiKey()}`;
  }
  const payload = JSON.stringify(toGeminiBody(body));

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errBody = await response.text();
      return { ok: false, status: response.status, body: errBody, error: `google ${response.status}` };
    }

    const raw = await response.json() as Record<string, unknown>;
    const anthropicResponse = fromGeminiResponse(raw, model);
    return { ok: true, status: 200, body: JSON.stringify(anthropicResponse) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export function proxyToAnthropic(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  body: AnthropicRequestBody,
  model: string,
  timeoutMs: number,
): Promise<UpstreamResult> {
  return new Promise((resolve) => {
    const baseUrl = new URL(getAnthropicBaseUrl());
    const isHttps = baseUrl.protocol === 'https:';
    const requester = isHttps ? httpsRequest : httpRequest;

    const providerAuth = getProviderAuth('anthropic', authConfig);
    const authHeaders = providerAuth
      ? buildAuthHeaders(providerAuth)
      : { 'x-api-key': getAnthropicApiKey() };

    const payload = JSON.stringify({ ...body, model });

    const req = requester(
      {
        hostname: baseUrl.hostname,
        port: baseUrl.port || (isHttps ? 443 : 80),
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...authHeaders,
          'anthropic-version': '2023-06-01',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString();
          const status = res.statusCode || 500;

          if (status === 429 || status >= 500) {
            resolve({ ok: false, status, body: responseBody, error: `anthropic ${status}` });
          } else {
            resolve({ ok: true, status, body: responseBody });
          }
        });
      },
    );

    req.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'anthropic timeout' });
    });

    req.write(payload);
    req.end();
  });
}

export async function proxyToOpenAI(
  body: AnthropicRequestBody,
  model: string,
  timeoutMs: number,
): Promise<UpstreamResult> {
  const providerAuth = getProviderAuth('openai', authConfig);
  if (!providerAuth) {
    return { ok: false, error: 'OpenAI provider not configured in auth.json' };
  }

  const openaiHeaders = buildAuthHeaders(providerAuth);
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
  const url = `${baseUrl}/v1/chat/completions`;
  const payload = JSON.stringify(toOpenAIBody(body, model));

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...openaiHeaders,
      },
      body: payload,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errBody = await response.text();
      return { ok: false, status: response.status, body: errBody, error: `openai ${response.status}` };
    }

    const raw = await response.json() as Record<string, unknown>;
    const anthropicResponse = fromOpenAIResponse(raw, model);
    return { ok: true, status: 200, body: JSON.stringify(anthropicResponse) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
