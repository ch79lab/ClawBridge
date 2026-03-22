import { describe, it, expect, vi } from 'vitest';
import { toOpenAIBody, fromOpenAIResponse } from '../src/upstream.js';
import type { AnthropicRequestBody } from '../src/types.js';

// Mock config to avoid loading real files
vi.mock('../src/config.js', () => ({
  getAnthropicApiKey: () => 'sk-ant-test',
  getAnthropicBaseUrl: () => 'https://api.anthropic.com',
  getGoogleApiKey: () => 'google-test',
  getOllamaUrl: () => 'http://localhost:11434',
  hasGoogleApiKey: () => true,
  authConfig: null,
}));

describe('toOpenAIBody', () => {
  it('converts system message to first message', () => {
    const body: AnthropicRequestBody = {
      model: 'ignored',
      messages: [{ role: 'user', content: 'hello' }],
      system: 'You are helpful',
    };
    const result = toOpenAIBody(body, 'gpt-4o');
    const messages = result.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: 'You are helpful' });
    expect(messages[1]).toEqual({ role: 'user', content: 'hello' });
    expect(result.model).toBe('gpt-4o');
  });

  it('converts content blocks to plain string', () => {
    const body: AnthropicRequestBody = {
      model: 'ignored',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: 'World' },
        ],
      }],
    };
    const result = toOpenAIBody(body, 'gpt-4o');
    const messages = result.messages as Array<{ role: string; content: string }>;
    expect(messages[0].content).toBe('Hello\nWorld');
  });

  it('passes max_tokens and temperature', () => {
    const body: AnthropicRequestBody = {
      model: 'ignored',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1000,
      temperature: 0.5,
    };
    const result = toOpenAIBody(body, 'gpt-4o');
    expect(result.max_tokens).toBe(1000);
    expect(result.temperature).toBe(0.5);
  });

  it('sets stream to false', () => {
    const body: AnthropicRequestBody = {
      model: 'ignored',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    };
    const result = toOpenAIBody(body, 'gpt-4o');
    expect(result.stream).toBe(false);
  });

  it('translates Anthropic tools to OpenAI format', () => {
    const body: AnthropicRequestBody = {
      model: 'ignored',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        name: 'get_weather',
        description: 'Get current weather',
        input_schema: { type: 'object', properties: { location: { type: 'string' } } },
      }],
    };
    const result = toOpenAIBody(body, 'gpt-4o');
    const tools = result.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get current weather',
        parameters: { type: 'object', properties: { location: { type: 'string' } } },
      },
    });
  });

  it('handles image content blocks for vision', () => {
    const body: AnthropicRequestBody = {
      model: 'ignored',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
          },
        ],
      }],
    };
    const result = toOpenAIBody(body, 'gpt-4o');
    const messages = result.messages as Array<{ role: string; content: unknown }>;
    const parts = messages[0].content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'text', text: 'What is this?' });
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,abc123' },
    });
  });
});

describe('fromOpenAIResponse', () => {
  it('maps basic response correctly', () => {
    const openaiResponse = {
      id: 'chatcmpl-123',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello there!' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    const result = fromOpenAIResponse(openaiResponse, 'gpt-4o');
    expect(result.model).toBe('openai/gpt-4o');
    expect(result.role).toBe('assistant');
    expect(result.stop_reason).toBe('end_turn');
    expect((result.content as Array<{ text: string }>)[0].text).toBe('Hello there!');
    expect((result.usage as Record<string, number>).input_tokens).toBe(10);
    expect((result.usage as Record<string, number>).output_tokens).toBe(5);
  });

  it('maps finish_reason "length" to "max_tokens"', () => {
    const response = {
      choices: [{ message: { content: 'cut off' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    };
    const result = fromOpenAIResponse(response, 'gpt-4o');
    expect(result.stop_reason).toBe('max_tokens');
  });

  it('maps finish_reason "tool_calls" to "tool_use"', () => {
    const response = {
      choices: [{ message: { content: '' }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    };
    const result = fromOpenAIResponse(response, 'gpt-4o');
    expect(result.stop_reason).toBe('tool_use');
  });

  it('handles empty/missing content', () => {
    const response = {
      choices: [{ message: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    };
    const result = fromOpenAIResponse(response, 'gpt-4o');
    expect((result.content as Array<{ text: string }>)[0].text).toBe('');
  });

  it('handles missing usage', () => {
    const response = {
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    };
    const result = fromOpenAIResponse(response, 'gpt-4o');
    expect((result.usage as Record<string, number>).input_tokens).toBe(0);
    expect((result.usage as Record<string, number>).output_tokens).toBe(0);
  });
});
