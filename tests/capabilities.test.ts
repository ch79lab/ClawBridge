import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectRequiredCapabilities, checkCapabilities, applyCapabilityUpgrade, getModelCapabilities } from '../src/capabilities.js';
import type { AnthropicRequestBody, Upstream } from '../src/types.js';

// Mock config
vi.mock('../src/config.js', () => ({
  routingConfig: {
    routes: {
      complex: { model: 'claude-sonnet-4-5', upstream: 'anthropic', timeoutMs: 60000, thinking: false },
      analysis: { model: 'gemini-2.5-flash', upstream: 'google', timeoutMs: 45000, thinking: false },
      action: { model: 'claude-haiku-4-5', upstream: 'anthropic', timeoutMs: 30000, thinking: false },
      batch: { model: 'gemini-2.5-flash-lite', upstream: 'google', timeoutMs: 20000, thinking: false },
      private_simple: { model: 'claude-haiku-4-5', upstream: 'anthropic', timeoutMs: 30000, thinking: false },
      private_complex: { model: 'claude-sonnet-4-5', upstream: 'anthropic', timeoutMs: 60000, thinking: false },
    },
    fallback_chain: [
      { model: 'gemini-2.5-flash', upstream: 'google', timeoutMs: 45000 },
      { model: 'claude-haiku-4-5', upstream: 'anthropic', timeoutMs: 30000 },
      { model: 'claude-sonnet-4-5', upstream: 'anthropic', timeoutMs: 60000 },
    ],
  },
  capabilitiesConfig: {
    models: {
      'claude-sonnet-4-5': {
        capabilities: ['tool_use', 'vision', 'long_context', 'code', 'multilingual', 'thinking'],
        max_context_tokens: 200000,
        max_output_tokens: 8192,
        strengths: ['complex_reasoning'],
        tier: 3,
      },
      'claude-haiku-4-5': {
        capabilities: ['tool_use', 'vision', 'long_context', 'code', 'multilingual'],
        max_context_tokens: 200000,
        max_output_tokens: 8192,
        strengths: ['fast_response'],
        tier: 2,
      },
      'gemini-2.5-flash': {
        capabilities: ['tool_use', 'vision', 'long_context', 'code', 'multilingual'],
        max_context_tokens: 1048576,
        max_output_tokens: 65536,
        strengths: ['long_documents'],
        tier: 2,
      },
      'gemini-2.5-flash-lite': {
        capabilities: ['long_context', 'multilingual'],
        max_context_tokens: 1048576,
        max_output_tokens: 65536,
        strengths: ['bulk_processing'],
        tier: 1,
      },
    },
    request_detection: {
      tool_use: { check: 'body.tools', description: 'Request includes tools' },
      vision: { check: 'messages contain images', description: 'Request includes images' },
      long_context: { token_threshold: 50000, description: 'Large input' },
    },
    upgrade_path: {
      'gemini-2.5-flash-lite': 'gemini-2.5-flash',
      'gemini-2.5-flash': 'claude-haiku-4-5',
      'claude-haiku-4-5': 'claude-sonnet-4-5',
    },
  },
}));

// Mock logger
vi.mock('../src/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock token estimator
vi.mock('../src/token_estimator.js', () => ({
  estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
}));

function makeBody(text: string, opts?: { tools?: unknown[]; images?: boolean }): AnthropicRequestBody {
  const content: Array<{ type: string; text?: string }> = [{ type: 'text', text }];
  if (opts?.images) {
    content.push({ type: 'image', text: undefined } as { type: string; text?: string });
  }
  return {
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content }],
    max_tokens: 1024,
    tools: opts?.tools,
  };
}

describe('detectRequiredCapabilities', () => {
  it('returns empty for simple text request', () => {
    const caps = detectRequiredCapabilities(makeBody('hello world'), 'hello world');
    expect(caps).toEqual([]);
  });

  it('detects tool_use when tools are present', () => {
    const body = makeBody('use this tool', { tools: [{ name: 'calculator', input_schema: {} }] });
    const caps = detectRequiredCapabilities(body, 'use this tool');
    expect(caps).toContain('tool_use');
  });

  it('detects vision when image blocks are present', () => {
    const body = makeBody('describe this image', { images: true });
    const caps = detectRequiredCapabilities(body, 'describe this image');
    expect(caps).toContain('vision');
  });

  it('detects multiple capabilities at once', () => {
    const body = makeBody('use this tool on the image', { tools: [{ name: 't' }], images: true });
    const caps = detectRequiredCapabilities(body, 'use this tool on the image');
    expect(caps).toContain('tool_use');
    expect(caps).toContain('vision');
  });
});

describe('getModelCapabilities', () => {
  it('returns capabilities for known model', () => {
    const caps = getModelCapabilities('claude-sonnet-4-5');
    expect(caps).not.toBeNull();
    expect(caps!.capabilities).toContain('tool_use');
    expect(caps!.tier).toBe(3);
  });

  it('returns null for unknown model', () => {
    const caps = getModelCapabilities('unknown-model');
    expect(caps).toBeNull();
  });
});

describe('checkCapabilities', () => {
  it('returns no upgrade needed when model has all capabilities', () => {
    const check = checkCapabilities('claude-sonnet-4-5', 'anthropic', ['tool_use', 'vision']);
    expect(check.upgrade_needed).toBe(false);
    expect(check.missing).toEqual([]);
  });

  it('returns no upgrade needed when no capabilities required', () => {
    const check = checkCapabilities('gemini-2.5-flash-lite', 'google', []);
    expect(check.upgrade_needed).toBe(false);
  });

  it('detects missing tool_use on flash-lite and suggests upgrade', () => {
    const check = checkCapabilities('gemini-2.5-flash-lite', 'google', ['tool_use']);
    expect(check.upgrade_needed).toBe(true);
    expect(check.missing).toContain('tool_use');
    expect(check.upgraded_model).toBe('gemini-2.5-flash');
    expect(check.upgraded_upstream).toBe('google');
  });

  it('detects missing vision on flash-lite and upgrades through chain', () => {
    const check = checkCapabilities('gemini-2.5-flash-lite', 'google', ['vision']);
    expect(check.upgrade_needed).toBe(true);
    expect(check.missing).toContain('vision');
    // flash-lite → flash (has vision)
    expect(check.upgraded_model).toBe('gemini-2.5-flash');
  });

  it('detects missing thinking and upgrades to sonnet', () => {
    const check = checkCapabilities('claude-haiku-4-5', 'anthropic', ['thinking']);
    expect(check.upgrade_needed).toBe(true);
    expect(check.missing).toContain('thinking');
    expect(check.upgraded_model).toBe('claude-sonnet-4-5');
  });

  it('handles unknown model gracefully', () => {
    const check = checkCapabilities('unknown-model', 'anthropic', ['tool_use']);
    expect(check.upgrade_needed).toBe(false);
  });
});

describe('applyCapabilityUpgrade', () => {
  it('no-op for simple text request', () => {
    const body = makeBody('hello');
    const result = applyCapabilityUpgrade('gemini-2.5-flash-lite', 'google', body, 'hello');
    expect(result.upgraded).toBe(false);
    expect(result.model).toBe('gemini-2.5-flash-lite');
  });

  it('upgrades flash-lite to flash when tools are needed', () => {
    const body = makeBody('use tool', { tools: [{ name: 'calc' }] });
    const result = applyCapabilityUpgrade('gemini-2.5-flash-lite', 'google', body, 'use tool');
    expect(result.upgraded).toBe(true);
    expect(result.model).toBe('gemini-2.5-flash');
    expect(result.upstream).toBe('google');
  });

  it('upgrades haiku to sonnet when thinking is needed', () => {
    // Note: thinking detection isn't automatic from request — only tool_use and vision are detected
    // This test directly checks the upgrade path
    const check = checkCapabilities('claude-haiku-4-5', 'anthropic', ['thinking']);
    expect(check.upgraded_model).toBe('claude-sonnet-4-5');
  });

  it('no upgrade needed when model already supports required caps', () => {
    const body = makeBody('use tool', { tools: [{ name: 'calc' }] });
    const result = applyCapabilityUpgrade('claude-sonnet-4-5', 'anthropic', body, 'use tool');
    expect(result.upgraded).toBe(false);
    expect(result.model).toBe('claude-sonnet-4-5');
  });
});
