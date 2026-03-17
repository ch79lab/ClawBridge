import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeWithFallback } from '../src/fallback.js';
import type { RoutingDecision, UpstreamResult } from '../src/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Mock upstream module
const mockProxyToOllama = vi.fn<() => Promise<UpstreamResult>>();
const mockProxyToGoogle = vi.fn<() => Promise<UpstreamResult>>();
const mockProxyToAnthropic = vi.fn<() => Promise<UpstreamResult>>();

vi.mock('../src/upstream.js', () => ({
  proxyToOllama: (...args: unknown[]) => mockProxyToOllama(...args),
  proxyToGoogle: (...args: unknown[]) => mockProxyToGoogle(...args),
  proxyToAnthropic: (...args: unknown[]) => mockProxyToAnthropic(...args),
}));

// Mock logger
vi.mock('../src/logger.js', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock config
vi.mock('../src/config.js', () => ({
  getOllamaUrl: () => 'http://localhost:11434',
  getAnthropicApiKey: () => 'test-key',
  getAnthropicBaseUrl: () => 'https://api.anthropic.com',
  getGoogleApiKey: () => 'test-key',
}));

const fakeReq = {} as IncomingMessage;
const fakeRes = {} as ServerResponse;
const fakeBody = {
  model: 'test',
  messages: [{ role: 'user' as const, content: 'hello' }],
};

function makeDecision(overrides?: Partial<RoutingDecision>): RoutingDecision {
  return {
    category: 'analysis',
    model: 'gemini-2.5-flash',
    upstream: 'google',
    timeoutMs: 45000,
    thinking: false,
    confidence: 0.9,
    fallback_chain: [
      { model: 'claude-haiku-4-5', upstream: 'anthropic', timeoutMs: 30000 },
      { model: 'claude-sonnet-4-5', upstream: 'anthropic', timeoutMs: 60000 },
    ],
    decision_trace: {
      privacy_gate: false,
      rules_hit: [],
      classifier_used: false,
    },
    ...overrides,
  };
}

describe('fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns on primary success', async () => {
    mockProxyToGoogle.mockResolvedValue({ ok: true, status: 200, body: '{"text":"ok"}' });

    const result = await executeWithFallback(fakeReq, fakeRes, fakeBody, makeDecision());
    expect(result.fallbackUsed).toBe(false);
    expect(result.finalModel).toBe('gemini-2.5-flash');
    expect(result.finalUpstream).toBe('google');
    expect(result.result.ok).toBe(true);
  });

  it('falls back to next on 500', async () => {
    // Google fails with 500 twice (1 original + 1 retry)
    mockProxyToGoogle.mockResolvedValue({ ok: false, status: 500, error: 'google 500' });
    // Anthropic succeeds
    mockProxyToAnthropic.mockResolvedValue({ ok: true, status: 200, body: '{"text":"ok"}' });

    const result = await executeWithFallback(fakeReq, fakeRes, fakeBody, makeDecision());
    expect(result.fallbackUsed).toBe(true);
    expect(result.finalModel).toBe('claude-haiku-4-5');
    expect(result.finalUpstream).toBe('anthropic');
  });

  it('falls back to next on timeout', async () => {
    mockProxyToGoogle.mockResolvedValue({ ok: false, error: 'timeout' });
    mockProxyToAnthropic.mockResolvedValue({ ok: true, status: 200, body: '{"text":"ok"}' });

    const result = await executeWithFallback(fakeReq, fakeRes, fakeBody, makeDecision());
    expect(result.fallbackUsed).toBe(true);
    expect(result.finalModel).toBe('claude-haiku-4-5');
  });

  it('does NOT retry or fallback on 4xx (except 429)', async () => {
    mockProxyToGoogle.mockResolvedValue({ ok: false, status: 400, error: 'bad request' });

    const result = await executeWithFallback(fakeReq, fakeRes, fakeBody, makeDecision());
    expect(result.result.ok).toBe(false);
    // Should NOT have called anthropic or ollama
    expect(mockProxyToAnthropic).not.toHaveBeenCalled();
    expect(mockProxyToOllama).not.toHaveBeenCalled();
  });

  it('retries on 429', async () => {
    // First call: 429, retry: success
    mockProxyToGoogle
      .mockResolvedValueOnce({ ok: false, status: 429, error: 'rate limited' })
      .mockResolvedValueOnce({ ok: true, status: 200, body: '{"text":"ok"}' });

    const result = await executeWithFallback(fakeReq, fakeRes, fakeBody, makeDecision());
    expect(result.result.ok).toBe(true);
    expect(result.fallbackUsed).toBe(false);
    expect(mockProxyToGoogle).toHaveBeenCalledTimes(2);
  });

  it('returns error when all upstreams fail', async () => {
    mockProxyToGoogle.mockResolvedValue({ ok: false, status: 500, error: 'google down' });
    mockProxyToAnthropic.mockResolvedValue({ ok: false, status: 500, error: 'anthropic down' });

    const result = await executeWithFallback(fakeReq, fakeRes, fakeBody, makeDecision());
    expect(result.result.ok).toBe(false);
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempts.length).toBeGreaterThan(2);
  });
});
