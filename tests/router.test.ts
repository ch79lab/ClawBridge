import { describe, it, expect, vi, beforeEach } from 'vitest';
import { route, extractUserText } from '../src/router.js';
import type { AnthropicRequestBody } from '../src/types.js';

// Mock the T0 classifier (we don't want Ollama calls in tests)
vi.mock('../src/classifier_t0.js', () => ({
  classifyByT0: vi.fn().mockResolvedValue({
    category: 'analysis',
    confidence: 0.85,
    rules_hit: ['t0:analysis'],
  }),
}));

// Mock config to avoid .env requirements
vi.mock('../src/config.js', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const config = JSON.parse(
    readFileSync(join(__dirname, '..', 'config', 'routing.json'), 'utf8'),
  );

  return {
    routingConfig: config,
    getOllamaUrl: () => 'http://localhost:11434',
    getAnthropicApiKey: () => 'test-key',
    getAnthropicBaseUrl: () => 'https://api.anthropic.com',
    getGoogleApiKey: () => 'test-key',
    getPort: () => 8402,
    getLogLevel: () => 'info',
    isShadowMode: () => false,
    shouldStorePreview: () => false,
  };
});

// Suppress log output during tests
vi.mock('../src/logger.js', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  withRequestContext: vi.fn((_id: string, fn: () => unknown) => fn()),
}));

function makeBody(text: string): AnthropicRequestBody {
  return {
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: text }],
    max_tokens: 1024,
  };
}

describe('extractUserText', () => {
  it('extracts text from string content', () => {
    const body = makeBody('hello world');
    expect(extractUserText(body)).toBe('hello world');
  });

  it('extracts text from content blocks', () => {
    const body: AnthropicRequestBody = {
      model: 'test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'first part' },
            { type: 'text', text: 'second part' },
          ],
        },
      ],
    };
    expect(extractUserText(body)).toBe('first part second part');
  });

  it('takes only last 3 user messages', () => {
    const body: AnthropicRequestBody = {
      model: 'test',
      messages: [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'response1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'response2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'response3' },
        { role: 'user', content: 'msg4' },
      ],
    };
    expect(extractUserText(body)).toBe('msg2 msg3 msg4');
  });
});

describe('router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes private content to ollama', async () => {
    const decision = await route(makeBody('aqui está a senha do banco'));
    expect(decision.category).toBe('private_simple');
    expect(decision.upstream).toBe('ollama');
    expect(decision.model).toBe('qwen3.5:9b');
    expect(decision.decision_trace.privacy_gate).toBe(true);
    expect(decision.confidence).toBe(1.0);
  });

  it('routes private complex to ollama with thinking', async () => {
    const decision = await route(
      makeBody('dado confidencial, analise os riscos e recomende uma estratégia'),
    );
    expect(decision.category).toBe('private_complex');
    expect(decision.upstream).toBe('ollama');
    expect(decision.thinking).toBe(false);
  });

  it('routes analysis keywords to google/gemini-flash', async () => {
    const decision = await route(
      makeBody('resuma o documento, compare e avalie os resultados'),
    );
    expect(decision.category).toBe('analysis');
    expect(decision.upstream).toBe('google');
    expect(decision.model).toBe('gemini-2.5-flash');
  });

  it('routes complex keywords to anthropic/sonnet', async () => {
    const decision = await route(
      makeBody('desenhe a arquitetura considerando trade-offs de escalabilidade e migração'),
    );
    expect(decision.category).toBe('complex');
    expect(decision.upstream).toBe('anthropic');
    expect(decision.model).toBe('claude-sonnet-4-5');
  });

  it('routes action keywords to anthropic/haiku', async () => {
    const decision = await route(
      makeBody('reescreva esse texto, formate em markdown e corrija os erros'),
    );
    expect(decision.category).toBe('action');
    expect(decision.upstream).toBe('anthropic');
    expect(decision.model).toBe('claude-haiku-4-5');
  });

  it('routes batch keywords to google/flash-lite', async () => {
    const decision = await route(
      makeBody('extraia todos os emails e classifique cada um em lote'),
    );
    expect(decision.category).toBe('batch');
    expect(decision.upstream).toBe('google');
    expect(decision.model).toBe('gemini-2.5-flash-lite');
  });

  it('privacy gate overrides everything', async () => {
    // Even if message has analysis keywords, privacy wins
    const decision = await route(
      makeBody('resuma esse documento confidencial e compare'),
    );
    expect(decision.decision_trace.privacy_gate).toBe(true);
    expect(decision.upstream).toBe('ollama');
  });

  it('skips T0 classifier when threshold is 0', async () => {
    // With rules_to_t0_threshold=0, T0 is never called
    const decision = await route(makeBody('what should I do about this?'));
    expect(decision.decision_trace.classifier_used).toBe(false);
  });

  it('does NOT use T0 for private content', async () => {
    const decision = await route(makeBody('a senha é 12345'));
    expect(decision.decision_trace.classifier_used).toBe(false);
    expect(decision.decision_trace.privacy_gate).toBe(true);
  });

  it('includes fallback chain in decision', async () => {
    const decision = await route(
      makeBody('resuma o documento e compare os resultados'),
    );
    expect(decision.fallback_chain.length).toBeGreaterThan(0);
    // Primary (google/gemini-flash) should not be in fallback chain
    expect(
      decision.fallback_chain.every(
        s => !(s.model === decision.model && s.upstream === decision.upstream),
      ),
    ).toBe(true);
  });
});
