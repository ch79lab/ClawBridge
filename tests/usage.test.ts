import { describe, it, expect, vi } from 'vitest';
import { extractTokensFromBody, calculateCost } from '../src/usage.js';

// Mock config to avoid .env requirements
vi.mock('../src/config.js', () => ({
  pricingConfig: {
    models: {
      'claude-sonnet-4-5': { input_per_1m: 3.0, output_per_1m: 15.0 },
      'claude-haiku-4-5': { input_per_1m: 0.8, output_per_1m: 4.0 },
      'gemini-2.5-flash': { input_per_1m: 0.15, output_per_1m: 0.6 },
      'gemini-2.5-flash-lite': { input_per_1m: 0.075, output_per_1m: 0.3 },
    },
    default: { input_per_1m: 0, output_per_1m: 0 },
  },
}));

// Mock logger
vi.mock('../src/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('extractTokensFromBody', () => {
  it('extracts tokens from Anthropic-format response', () => {
    const body = JSON.stringify({
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const tokens = extractTokensFromBody(body);
    expect(tokens.input_tokens).toBe(100);
    expect(tokens.output_tokens).toBe(50);
  });

  it('extracts tokens from Google-translated response', () => {
    // upstream.ts wraps Google responses into Anthropic format
    const body = JSON.stringify({
      id: 'msg_google_123',
      type: 'message',
      role: 'assistant',
      model: 'google/gemini-2.5-flash',
      content: [{ type: 'text', text: 'response' }],
      usage: { input_tokens: 200, output_tokens: 80 },
    });
    const tokens = extractTokensFromBody(body);
    expect(tokens.input_tokens).toBe(200);
    expect(tokens.output_tokens).toBe(80);
  });

  it('extracts tokens from Ollama-translated response', () => {
    const body = JSON.stringify({
      id: 'msg_local_123',
      type: 'message',
      role: 'assistant',
      model: 'ollama/qwen3.5:9b',
      content: [{ type: 'text', text: 'response' }],
      usage: { input_tokens: 150, output_tokens: 60 },
    });
    const tokens = extractTokensFromBody(body);
    expect(tokens.input_tokens).toBe(150);
    expect(tokens.output_tokens).toBe(60);
  });

  it('returns zeros for undefined body', () => {
    const tokens = extractTokensFromBody(undefined);
    expect(tokens.input_tokens).toBe(0);
    expect(tokens.output_tokens).toBe(0);
  });

  it('returns zeros for invalid JSON', () => {
    const tokens = extractTokensFromBody('not json');
    expect(tokens.input_tokens).toBe(0);
    expect(tokens.output_tokens).toBe(0);
  });

  it('returns zeros for missing usage field', () => {
    const body = JSON.stringify({ id: 'msg_123', content: [] });
    const tokens = extractTokensFromBody(body);
    expect(tokens.input_tokens).toBe(0);
    expect(tokens.output_tokens).toBe(0);
  });
});

describe('calculateCost', () => {
  it('calculates cost for claude-haiku-4-5', () => {
    // 1000 input tokens at $0.80/1M = $0.0008
    // 500 output tokens at $4.00/1M = $0.002
    const cost = calculateCost('claude-haiku-4-5', 1000, 500);
    expect(cost.cost_input).toBeCloseTo(0.0008, 6);
    expect(cost.cost_output).toBeCloseTo(0.002, 6);
    expect(cost.cost_total).toBeCloseTo(0.0028, 6);
  });

  it('calculates cost for claude-sonnet-4-5', () => {
    // 1000 input at $3/1M = $0.003
    // 1000 output at $15/1M = $0.015
    const cost = calculateCost('claude-sonnet-4-5', 1000, 1000);
    expect(cost.cost_input).toBeCloseTo(0.003, 6);
    expect(cost.cost_output).toBeCloseTo(0.015, 6);
    expect(cost.cost_total).toBeCloseTo(0.018, 6);
  });

  it('calculates cost for gemini-2.5-flash', () => {
    // 10000 input at $0.15/1M = $0.0015
    // 5000 output at $0.60/1M = $0.003
    const cost = calculateCost('gemini-2.5-flash', 10000, 5000);
    expect(cost.cost_input).toBeCloseTo(0.0015, 6);
    expect(cost.cost_output).toBeCloseTo(0.003, 6);
    expect(cost.cost_total).toBeCloseTo(0.0045, 6);
  });

  it('returns zero cost for unknown model (uses default)', () => {
    const cost = calculateCost('unknown-model', 1000, 1000);
    expect(cost.cost_input).toBe(0);
    expect(cost.cost_output).toBe(0);
    expect(cost.cost_total).toBe(0);
  });

  it('handles zero tokens', () => {
    const cost = calculateCost('claude-haiku-4-5', 0, 0);
    expect(cost.cost_total).toBe(0);
  });
});
