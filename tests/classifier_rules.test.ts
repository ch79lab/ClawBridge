import { describe, it, expect } from 'vitest';
import { classifyByRules } from '../src/classifier_rules.js';
import type { RoutingConfig } from '../src/types.js';

// Load the actual routing config for realistic tests
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config: RoutingConfig = JSON.parse(
  readFileSync(join(__dirname, '..', 'config', 'routing.json'), 'utf8'),
);

// Helper: for single-message tests, recentText and lastText are the same
function classify(text: string) {
  return classifyByRules(text, text, config);
}

describe('classifier_rules', () => {
  describe('privacy gate', () => {
    it('routes "senha" to private_simple', () => {
      const result = classify('qual é a senha do banco?');
      expect(result.category).toBe('private_simple');
      expect(result.confidence).toBe(1.0);
      expect(result.rules_hit).toContain('privacy_gate:keyword:"senha"');
    });

    it('routes "password" to private_simple', () => {
      const result = classify('store this password safely');
      expect(result.category).toBe('private_simple');
      expect(result.confidence).toBe(1.0);
    });

    it('routes "confidencial" to private_simple', () => {
      const result = classify('esse documento é confidencial');
      expect(result.category).toBe('private_simple');
      expect(result.confidence).toBe(1.0);
    });

    it('routes CPF pattern to private_simple', () => {
      const result = classify('meu CPF é 123.456.789-00');
      expect(result.category).toBe('private_simple');
      expect(result.confidence).toBe(1.0);
      expect(result.rules_hit).toContain('privacy_gate:pii_pattern');
    });

    it('routes CNPJ pattern to private_simple', () => {
      const result = classify('CNPJ da empresa: 12.345.678/0001-90');
      expect(result.category).toBe('private_simple');
      expect(result.confidence).toBe(1.0);
    });

    it('routes credit card pattern to private_simple', () => {
      const result = classify('meu cartão é 4111 1111 1111 1111');
      expect(result.category).toBe('private_simple');
      expect(result.confidence).toBe(1.0);
    });

    it('routes API key pattern to private_simple', () => {
      const result = classify('use this key sk-abcdefghijklmnopqrstuvwxyz1234567890');
      expect(result.category).toBe('private_simple');
      expect(result.confidence).toBe(1.0);
    });

    it('routes SSH key to private_simple', () => {
      const result = classify('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample');
      expect(result.category).toBe('private_simple');
      expect(result.confidence).toBe(1.0);
    });

    it('routes "confidencial" + complexity keywords to private_complex', () => {
      const result = classify(
        'esse contrato é confidencial, analise os riscos e recomende uma estratégia',
      );
      expect(result.category).toBe('private_complex');
      expect(result.confidence).toBe(1.0);
      expect(result.rules_hit).toContain('private_complexity:complex');
    });

    it('routes sensitive + "trade-off" to private_complex', () => {
      const result = classify(
        'dado confidencial, avalie o trade-off entre as opções',
      );
      expect(result.category).toBe('private_complex');
      expect(result.confidence).toBe(1.0);
    });

    it('privacy gate uses recent context, not just last message', () => {
      // recentText has "senha", but lastText does not
      const result = classifyByRules(
        'a senha é 1234 resuma o documento',
        'resuma o documento',
        config,
      );
      expect(result.category).toBe('private_simple');
      expect(result.confidence).toBe(1.0);
    });
  });

  describe('category scoring', () => {
    it('classifies "resuma o documento" as analysis', () => {
      const result = classify('resuma o documento e compare com o anterior');
      expect(result.category).toBe('analysis');
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('classifies "summarize" as analysis', () => {
      const result = classify('summarize the report and evaluate the findings');
      expect(result.category).toBe('analysis');
    });

    it('classifies "reescreva em markdown" as action', () => {
      const result = classify('reescreva esse texto em markdown e formate');
      expect(result.category).toBe('action');
    });

    it('classifies "convert to JSON" as action', () => {
      const result = classify('convert this data to JSON format');
      expect(result.category).toBe('action');
    });

    it('classifies "extraia todos os emails" as batch', () => {
      const result = classify('extraia todos os emails da lista e classifique cada um');
      expect(result.category).toBe('batch');
    });

    it('classifies "extract all" as batch', () => {
      const result = classify('extract all names from each row and parse the data');
      expect(result.category).toBe('batch');
    });

    it('classifies "desenhe a arquitetura" as complex', () => {
      const result = classify(
        'desenhe a arquitetura considerando trade-offs de escalabilidade e migração',
      );
      expect(result.category).toBe('complex');
    });

    it('classifies "design the architecture" as complex', () => {
      const result = classify(
        'design the architecture and consider scalability trade-offs for the migration strategy',
      );
      expect(result.category).toBe('complex');
    });

    it('category scoring uses only lastText, ignoring history', () => {
      // recentText has batch keywords, but lastText has analysis keywords
      const result = classifyByRules(
        'extraia todos os emails e classifique cada um resuma o documento e compare',
        'resuma o documento e compare',
        config,
      );
      expect(result.category).toBe('analysis');
    });
  });

  describe('edge cases', () => {
    it('handles empty message with low confidence', () => {
      const result = classify('');
      expect(result.confidence).toBeLessThanOrEqual(0.5);
      expect(result.rules_hit).toContain('no_keyword_hits');
    });

    it('handles generic message with low confidence', () => {
      const result = classify('hello there');
      expect(result.confidence).toBeLessThanOrEqual(0.5);
    });

    it('handles mixed keywords — highest score wins', () => {
      const result = classify(
        'analise, compare, avalie e resuma os resultados. Depois formate.',
      );
      expect(result.category).toBe('analysis');
    });

    it('handles case-insensitive matching', () => {
      const result = classify('RESUMA O DOCUMENTO E COMPARE');
      expect(result.category).toBe('analysis');
    });
  });
});
