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

describe('classifier_rules', () => {
  describe('privacy gate', () => {
    it('routes "senha" to private_simple', () => {
      const result = classifyByRules('qual é a senha do banco?', config);
      expect(result.category).toBe('private_simple');
      expect(result.confidence).toBe(1.0);
      expect(result.rules_hit).toContain('privacy_gate:keyword:"senha"');
    });

    it('routes "password" to private_simple', () => {
      const result = classifyByRules('store this password safely', config);
      expect(result.category).toBe('private_simple');
      expect(result.confidence).toBe(1.0);
    });

    it('routes "confidencial" to private_simple', () => {
      const result = classifyByRules('esse documento é confidencial', config);
      expect(result.category).toBe('private_simple');
      expect(result.confidence).toBe(1.0);
    });

    it('routes CPF pattern to private_simple', () => {
      const result = classifyByRules('meu CPF é 123.456.789-00', config);
      expect(result.category).toBe('private_simple');
      expect(result.confidence).toBe(1.0);
      expect(result.rules_hit).toContain('privacy_gate:pii_pattern');
    });

    it('routes CNPJ pattern to private_simple', () => {
      const result = classifyByRules('CNPJ da empresa: 12.345.678/0001-90', config);
      expect(result.category).toBe('private_simple');
      expect(result.confidence).toBe(1.0);
    });

    it('routes credit card pattern to private_simple', () => {
      const result = classifyByRules('meu cartão é 4111 1111 1111 1111', config);
      expect(result.category).toBe('private_simple');
      expect(result.confidence).toBe(1.0);
    });

    it('routes API key pattern to private_simple', () => {
      const result = classifyByRules('use this key sk-abcdefghijklmnopqrstuvwxyz1234567890', config);
      expect(result.category).toBe('private_simple');
      expect(result.confidence).toBe(1.0);
    });

    it('routes SSH key to private_simple', () => {
      const result = classifyByRules('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample', config);
      expect(result.category).toBe('private_simple');
      expect(result.confidence).toBe(1.0);
    });

    it('routes "confidencial" + complexity keywords to private_complex', () => {
      const result = classifyByRules(
        'esse contrato é confidencial, analise os riscos e recomende uma estratégia',
        config,
      );
      expect(result.category).toBe('private_complex');
      expect(result.confidence).toBe(1.0);
      expect(result.rules_hit).toContain('private_complexity:complex');
    });

    it('routes sensitive + "trade-off" to private_complex', () => {
      const result = classifyByRules(
        'dado interno, avalie o trade-off entre as opções',
        config,
      );
      expect(result.category).toBe('private_complex');
      expect(result.confidence).toBe(1.0);
    });
  });

  describe('category scoring', () => {
    it('classifies "resuma o documento" as analysis', () => {
      const result = classifyByRules('resuma o documento e compare com o anterior', config);
      expect(result.category).toBe('analysis');
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('classifies "summarize" as analysis', () => {
      const result = classifyByRules('summarize the report and evaluate the findings', config);
      expect(result.category).toBe('analysis');
    });

    it('classifies "reescreva em markdown" as action', () => {
      const result = classifyByRules('reescreva esse texto em markdown e formate', config);
      expect(result.category).toBe('action');
    });

    it('classifies "convert to JSON" as action', () => {
      const result = classifyByRules('convert this data to JSON format', config);
      expect(result.category).toBe('action');
    });

    it('classifies "extraia todos os emails" as batch', () => {
      const result = classifyByRules('extraia todos os emails da lista e classifique cada um', config);
      expect(result.category).toBe('batch');
    });

    it('classifies "extract all" as batch', () => {
      const result = classifyByRules('extract all names from each row and parse the data', config);
      expect(result.category).toBe('batch');
    });

    it('classifies "desenhe a arquitetura" as complex', () => {
      const result = classifyByRules(
        'desenhe a arquitetura considerando trade-offs de escalabilidade e migração',
        config,
      );
      expect(result.category).toBe('complex');
    });

    it('classifies "design the architecture" as complex', () => {
      const result = classifyByRules(
        'design the architecture and consider scalability trade-offs for the migration strategy',
        config,
      );
      expect(result.category).toBe('complex');
    });
  });

  describe('edge cases', () => {
    it('handles empty message with low confidence', () => {
      const result = classifyByRules('', config);
      expect(result.confidence).toBeLessThanOrEqual(0.5);
      expect(result.rules_hit).toContain('no_keyword_hits');
    });

    it('handles generic message with low confidence', () => {
      const result = classifyByRules('hello there', config);
      expect(result.confidence).toBeLessThanOrEqual(0.5);
    });

    it('handles mixed keywords — highest score wins', () => {
      // More analysis keywords than action keywords
      const result = classifyByRules(
        'analise, compare, avalie e resuma os resultados. Depois formate.',
        config,
      );
      expect(result.category).toBe('analysis');
    });

    it('handles case-insensitive matching', () => {
      const result = classifyByRules('RESUMA O DOCUMENTO E COMPARE', config);
      expect(result.category).toBe('analysis');
    });
  });
});
