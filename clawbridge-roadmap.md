# ClawBridge Roadmap

## Posição

ClawBridge não deve virar gateway horizontal nem marketplace de providers.

A tese correta é:

**ser um decision engine especializado para OpenClaw**, focado em:
- roteamento melhor por tipo de workload
- otimização de custo com guardrails explícitos
- garantia de performance com fallback e seleção orientados por evidência
- decisão explicável
- implantação progressivamente mais simples

## Contexto atualizado

Mudanças já feitas na configuração:
- remoção de `ollama`
- `private_simple` agora roteia para **Haiku**
- `private_complex` agora roteia para **Sonnet**

### Implicação estratégica

Isso muda a natureza do ClawBridge:

- antes, o produto tinha uma tese explícita de **local-first privacy routing**
- agora, a proteção de privacidade deixou de ser uma decisão de execução local e passou a ser uma decisão de **modelo cloud mais conservador/delicado**
- portanto, a categoria `private_*` continua útil, mas o significado precisa ser redefinido

### Nova interpretação recomendada para `private_*`

Em vez de significar “nunca sai da máquina”, deve passar a significar:

- **private_simple** = conteúdo sensível de baixa complexidade que pede resposta barata, rápida e mais contida
- **private_complex** = conteúdo sensível de maior complexidade que exige modelo mais forte e maior confiabilidade

Consequência: a documentação e a política do produto precisam parar de prometer privacidade local absoluta.

A política correta passa a ser algo como:

> requests sensíveis são roteados para caminhos mais controlados e mais conservadores, com priorização de menor exposição operacional e maior previsibilidade de comportamento.

---

## Diagnóstico do estágio atual

### O que o ClawBridge já acerta

- intercepta requests do OpenClaw sem exigir fork pesado do cliente
- já possui lógica de classificação e roteamento
- já trata fallback como parte da arquitetura
- já nasce com visão de custo e performance
- já tem um recorte claro: melhorar decisão, não apenas repassar requests

### O que ainda limita o produto

- ~~classificação ainda parece simples demais para workloads ambíguos~~ → mitigado com T0 classifier + escalation
- ~~capabilities reais dos modelos não estão formalizadas em um registry explícito~~ → ✅ `config/capabilities.json`
- ~~fallback tende a ser mais linear do que contextual~~ → ✅ reordenação dinâmica por health score
- ~~custo ainda tende a ser tratado por heurística, não por política formal~~ → ✅ budget progressivo com 4 níveis
- ~~performance observada ainda não parece ser o principal insumo da decisão~~ → ✅ SLO-aware health tracker
- ~~setup e debugging ainda geram atrito excessivo~~ → ✅ `npm run doctor`
- ~~a semântica de `private_*` ficou mais fraca após remoção do local execution~~ → ✅ redefinida como "caminhos mais conservadores"
- classificação por sessão ainda não existe (depende de Fase 4)
- não há aprendizado com outcomes reais (depende de Fase 5)

---

## Reposicionamento necessário

## Missão do produto

**Escolher a melhor rota de inferência para cada request, dentro de restrições de custo, performance, sensibilidade e confiabilidade.**

## O que o ClawBridge deve ser

- router especializado
- decision engine explicável
- policy engine enxuto
- camada fina entre OpenClaw e modelos

## O que o ClawBridge não deve ser

- gateway universal
- catálogo enorme de providers
- dashboard-first product
- broker de capacity
- réplica simplificada de LiteLLM ou OpenRouter

---

## Princípios de produto

### 1. Melhor decisão antes de mais integração
Mais valor virá de acertar melhor a escolha do modelo do que de suportar dezenas de providers.

### 2. Custo só importa se qualidade mínima for preservada
O barato errado gera retry, fallback e escalada posterior.

### 3. Performance precisa ser observada, não presumida
Modelo “bom” em tese pode estar ruim agora por latência, erro ou saturação.

### 4. Sensibilidade precisa ser tratada como policy
Com a remoção do local execution, sensibilidade não pode mais ser vendida como isolamento total.

### 5. Explicabilidade é parte do produto
O usuário precisa entender por que uma rota foi escolhida.

### 6. Simplicidade de implantação é parte do valor
Setup difícil destrói adoção antes do roteamento provar seu valor.

---

## Roadmap estruturado

## Fase 0 — Core Hardening ✅

### Objetivo
Estabilizar o núcleo antes de sofisticar a decisão.

### Entregas
- ✅ revisar a semântica e nomenclatura de `private_simple` e `private_complex`
- ✅ revisar README e mensagens do produto para remover promessas de privacidade local
- ✅ corrigir thresholds e pesos do classificador atual
- ✅ formalizar interface de adapters por provider
- ✅ padronizar tratamento de erro por upstream
- ✅ garantir compatibilidade de protocolo ponta a ponta
- ✅ registrar decisão de rota, fallback, latência e custo estimado

### Status
Completa. Usage tracking (JSONL), structured logging, privacy gate, fallback chain, protocol translation (Anthropic ↔ Google) — tudo implementado e em produção.

---

## Fase 0.5 — Deployment & Debug Simplification ✅

### Objetivo
Reduzir brutalmente o tempo gasto em setup, ajuste manual e troubleshooting.

### Entregas
- ✅ `npm run doctor` — valida .env, configs JSON, conectividade com providers, coerência routing/pricing
- ✅ mensagens de erro acionáveis (cada check com ✓/✗ e diagnóstico claro)
- ✅ LaunchAgent plist para auto-start no macOS

### Status
Completa. `npm run doctor` implementado com 7 categorias de checks (env, routing, pricing, budget, capabilities, data dir, upstream connectivity). Deploy simplificado com LaunchAgent.

---

## Fase 1 — Capability-Aware Router ✅

### Objetivo
Sair de roteamento apenas por categoria e passar a decidir por capacidade exigida.

### Entregas
- ✅ `config/capabilities.json` — registry com capabilities, max_tokens, strengths, tier por modelo
- ✅ `src/capabilities.ts` — detecta tool_use, vision, long_context no request body
- ✅ upgrade path automático: flash-lite → flash → haiku → sonnet
- ✅ `POST /v1/clawbridge/route/explain` — dry-run com full decision trace
- ✅ 16 testes unitários

### Status
Completa. Capability upgrade roda após budget downgrade no pipeline (Step 4c), garantindo que mesmo após downgrade por budget, capabilities essenciais são preservadas.

---

## Fase 2 — Economic Router ✅

### Objetivo
Transformar custo em policy explícita, não em consequência implícita.

### Entregas
- ✅ `config/budget.json` — budget mensal com thresholds e downgrade map
- ✅ `src/budget.ts` — getBudgetStatus(), applyBudgetDowngrade(), getRegretStats()
- ✅ Limites derivados automáticos (diário/semanal calculados do mensal)
- ✅ Detecção de spikes (diário 3x média 7d, semanal 1.5x média)
- ✅ Pacing (esperado vs real)
- ✅ 4 níveis: normal → warn → downgrade → hard_stop
- ✅ `GET /v1/clawbridge/budget` — status completo
- ✅ `GET /v1/clawbridge/budget/regret` — regret stats
- ✅ Private categories nunca sofrem downgrade
- ✅ 15 testes unitários

### Status
Completa. Budget progressivo com downgrade automático integrado no pipeline (Step 4b). Usage tracking em JSONL com custo real por request.

---

## Fase 3 — SLO-Aware Router ✅

### Objetivo
Garantir performance com base em dados recentes de execução.

### Entregas
- ✅ `src/health.ts` — sliding window (50 outcomes/modelo) com decay temporal (24h)
- ✅ health_score composto: success_rate × 0.7 + (1 - latency_penalty) × 0.3
- ✅ Latency percentiles (p50, p95, avg) por modelo
- ✅ Reordenação dinâmica de fallback chain por health score (Step 5b)
- ✅ `GET /v1/clawbridge/health` — health scores + dynamic fallback order
- ✅ recordOutcome() em ambos os paths (piped + buffered)
- ✅ 16 testes unitários

### Status
Completa. Health tracker in-memory (reseta no restart — intencional para fresh assessment). MIN_SAMPLES=3 para evitar reordenação prematura.

---

## Fase 3.5 — Multi-Provider & Routing Tiers v2 ✅

### Objetivo
Expandir de 2 providers (Anthropic + Google) para 3 (+ OpenRouter), adicionar 4 novos tiers (default, vision, code, deep_analysis) e hardening do classificador para produção via Telegram.

### Entregas
- ✅ OpenRouter como 3o provider (Grok 4.1 Fast, MiniMax M2.5)
- ✅ Protocol translation OpenAI-compatible (`proxyToOpenAICompatible`)
- ✅ 10 tiers operacionais (adicionados: default, vision, code, deep_analysis)
- ✅ Multi-auth configurável (`config/auth.json` — API key, Bearer, URL param)
- ✅ Rate limiting por tier (`config/rate-limits.json` — hourly/daily caps)
- ✅ Metadata stripping — remove metadados OpenClaw/Telegram da classificação
- ✅ Short-circuit classifier v2 (privacy → vision → batch → domain → legacy)
- ✅ Model rewrite — resposta retorna com modelo original do request (transparência pro OpenClaw)
- ✅ Remoção de OAuth/ChatGPT backend (não viável para acesso programático)
- ✅ Sonnet 4-5 → 4-6, adicionado Gemini 3.1 Pro Preview
- ✅ Doctor expandido (auth.json, rate-limits.json, OpenRouter connectivity)
- ✅ 133 testes (9 suites)

### Bugs corrigidos
- Tool call detection desabilitado (OpenClaw envia tools[] em todo request)
- Privacy gate restrito a lastText (evita false positives por histórico)
- Domain detection com `rules.reasoning` separado de `privacy.complexity_keywords`
- Fallback para `default` (não `action`) em zero-keyword messages
- `convert to JSON` não classificava mais como `analysis` (keyword `data` genérico demais)

### Status
Completa. 9/10 tiers validados em produção via Telegram no Mac Mini M4. Vision funciona via API direta (ClawBridge → Gemini Flash); pendente integração end-to-end via Telegram (limitação do pipeline imageModel do OpenClaw).

---

## Fase 4 — Session-Aware Router

### Objetivo
Melhorar decisões usando contexto da sessão, não só do request isolado.

### Entregas
- memória curta de sessão
- sinais de continuidade
  - retries recentes
  - frustração implícita
  - escaladas sucessivas
  - histórico de tool-heavy flow
- regras como:
  - se já falhou barato duas vezes, não insistir em rota econômica
  - se sessão já está em raciocínio profundo, evitar downgrade prematuro
- ajuste de rota com base em trajetória, não só instantâneo

### Critérios de saída
- menos repetição de erro na mesma sessão
- melhor continuidade de qualidade
- menos loops desnecessários de fallback

### Prioridade
Média

---

## Fase 5 — Outcome-Aware Learning

### Objetivo
Fazer o ClawBridge aprender com resultados observáveis.

### Entregas
- shadow routing sério
- champion vs challenger
- replay offline de requests históricos
- reponderação de score com base em sinais pós-execução
- aprendizado leve orientado por outcome

### Sinais de outcome
- retry logo após resposta
- upgrade manual para modelo mais forte
- fallback encadeado
- resposta descartada/substituída
- troca recorrente de rota em mesmo padrão de workload

### Importante
Não começar com modelo “mágico” aprendendo tudo.
Começar com:
- heurística assistida por evidência
- reponderação simples
- comparação estruturada

### Critérios de saída
- mudanças de policy passam a ser testadas com dados
- melhoria cumulativa do roteamento
- redução de tuning manual cego

### Prioridade
Média

---

## Fase 6 — Specialized Agent Router

### Objetivo
Criar diferenciação real para workloads de agentes e coding flows.

### Entregas
- taxonomia própria de workload
  - chat
  - coding
  - editing
  - tool-heavy
  - batch
  - sensitive
  - long-context
- políticas específicas por workload
- tuning para OpenClaw workflows reais
- specialization de fallback por tipo de agente
- score híbrido:
  - quality
  - cost
  - latency
  - sensitivity
  - execution fit

### Critérios de saída
- ClawBridge deixa de ser “router genérico”
- passa a ser claramente melhor em cenários agentic/coding

### Prioridade
Média

---

## Ordem recomendada

1. ✅ Fase 0 — Core Hardening
2. ✅ Fase 0.5 — Deployment & Debug Simplification
3. ✅ Fase 1 — Capability-Aware Router
4. ✅ Fase 2 — Economic Router
5. ✅ Fase 3 — SLO-Aware Router
6. ✅ Fase 3.5 — Multi-Provider & Routing Tiers v2
7. Fase 4 — Session-Aware Router
8. Fase 5 — Outcome-Aware Learning
9. Fase 6 — Specialized Agent Router

---

## Backlog imediato recomendado

## Bloco A — ✅ completo

- ✅ revisar documentação e semântica de `private_*`
- ✅ criar `capability_registry` (`config/capabilities.json`)
- ✅ criar `route_explainer` (`POST /v1/clawbridge/route/explain`)
- ✅ instrumentar métricas mínimas (`data/usage.jsonl`)
- ✅ criar `clawbridge doctor` (`npm run doctor`)
- ✅ validate-config (integrado no doctor)

## Bloco B — ✅ completo

- ✅ cost ceilings (budget progressivo com 4 níveis)
- ✅ regret tracking (`GET /v1/clawbridge/budget/regret`)
- ✅ execution score (health_score por modelo)
- ✅ fallback reordenação dinâmica por health
- ✅ quickstart funcional (doctor + LaunchAgent)

## Bloco C — próximo

- vision end-to-end via Telegram (depende de fix no pipeline imageModel do OpenClaw)
- cost dashboard (endpoint `/v1/clawbridge/dashboard` com HTML)
- T0 classifier re-enable (desabilitado por latência, avaliar com modelo local menor)
- shadow routing
- replay offline
- session-aware adaptation
- specialization por workload agentic

---

## Riscos principais

### 1. Ambiguidade de privacidade
Sem execução local, chamar `private_*` de “privado” pode gerar promessa maior do que o sistema cumpre.

### 2. Complexidade excessiva cedo demais
Se tentar aprender dinamicamente antes de medir bem, o sistema fica opaco e difícil de depurar.

### 3. Otimização de custo míope
Economia aparente pode piorar custo total por retry, fallback e escalada.

### 4. Product sprawl
Se o produto começar a absorver funções de gateway, broker e dashboard, perde foco.

### 5. Déficit de adoção
Se setup continuar doloroso, o motor pode até melhorar, mas ninguém percebe o valor.

---

## Métricas de sucesso recomendadas

### Produto
- time to first successful route
- tempo médio de troubleshooting
- taxa de requests roteados sem intervenção manual
- taxa de adoção do starter profile

### Decisão
- route accuracy proxy
- retry rate
- override rate
- fallback rate
- escalation rate

### Economia
- custo médio por request
- custo médio por categoria
- economia vs baseline estático
- regret cost

### Performance
- TTFT
- p50/p95 latência
- taxa de erro por rota
- estabilidade por modelo

---

## Veredito final

O ClawBridge continua com uma tese boa.

Mas, após a remoção do Ollama, ele precisa assumir com clareza que:

- não é mais um router local-first de privacidade forte
- é um **router especializado de custo, performance, sensibilidade e confiabilidade**

A evolução certa não é abrir escopo.

É aprofundar a qualidade da decisão e reduzir o atrito de implantação.

Se fizer isso bem, o produto sai da categoria “proxy com regras” e entra na categoria “decision engine especializado”.
