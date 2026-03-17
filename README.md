# ClawBridge

> **[Português](#português)** · **[English](#english)**

---

## Português

Decision engine de roteamento adaptativo de LLMs para [OpenClaw](https://github.com/openclaw/openclaw). Senta entre o OpenClaw e os provedores de LLM, classificando cada request e roteando para o modelo mais adequado por custo, capability e performance.

### Por que usar

Com a configuração padrão do OpenClaw, todo request vai para o mesmo modelo. Heartbeat? Sonnet. Pergunta simples? Sonnet. Revisão de arquitetura complexa? Sonnet também.

ClawBridge resolve isso com roteamento inteligente:
- **Custo eficiente**: modelos baratos para tarefas simples, premium para complexas
- **Budget progressivo**: limites diários/semanais/mensais com downgrade automático
- **Capability-aware**: detecta tool_use, vision, long_context e faz upgrade automático
- **SLO-aware**: health score por modelo com reordenação dinâmica de fallback
- **Resiliente**: fallback automático quando um provedor falha
- **Observável**: toda decisão é logada e explicável via endpoint

### Arquitetura

```
Telegram / CLI / Canal
         │
         ▼
OpenClaw Gateway (:18789)
         │
         ▼  (API compatível com Anthropic, POST /v1/messages)
   ClawBridge Proxy (:8402)
      ├─ privacy gate (keywords + regex PII)
      ├─ classificador por regras (scoring de keywords)
      ├─ budget check (downgrade progressivo)
      ├─ capability check (upgrade automático)
      └─ health-aware fallback (reordenação dinâmica)
         │
     ┌───┼───────────────┐
     ▼                   ▼
  Cloud A             Cloud B
  Anthropic           Google Gemini
```

### Tiers de Modelo

Todos os tiers são configuráveis em `config/routing.json`:

| Tier | Categoria | Modelo Padrão | Uso |
|---|---|---|---|
| T1 | Complex | Anthropic Sonnet | Arquitetura, estratégia, trade-offs |
| T2 | Analysis | Google Gemini Flash | Resumir, comparar, avaliar |
| T3 | Action | Anthropic Haiku | Reescrever, formatar, transformar |
| T4 | Batch | Google Gemini Flash Lite | Extrair, classificar, parsear |
| T5 | Private Simple | Anthropic Haiku | Conteúdo sensível, baixa complexidade |
| T6 | Private Complex | Anthropic Sonnet | Conteúdo sensível, alta complexidade |

### Política de Roteamento

1. **Privacy gate** (sempre primeiro) — keywords, padrões PII, padrões de credenciais → rota conservadora
2. **Classificador por regras** — scoring de keywords por categoria
3. **Budget check** — downgrade progressivo baseado em gasto (diário → semanal → mensal)
4. **Capability check** — se request exige tool_use/vision que o modelo não suporta → upgrade automático
5. **Health-aware fallback** — cadeia de fallback reordenada por health score recente
6. **Cadeia de fallback** — em 429/5xx/timeout, tenta o próximo provedor automaticamente

### Instalação

```bash
# Instalar dependências
npm install

# Configurar
cp .env.example .env
# Edite .env com suas API keys

# Verificar configuração
npm run doctor

# Rodar
npm run dev

# Testar
npm test
```

### Variáveis de Ambiente

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `PORT` | Não | `8402` | Porta do proxy |
| `ANTHROPIC_API_KEY` | Sim | — | API key Anthropic |
| `ANTHROPIC_BASE_URL` | Não | `https://api.anthropic.com` | URL base API Anthropic |
| `GOOGLE_API_KEY` | Sim* | — | API key Google AI |
| `SHADOW_MODE` | Não | `false` | Logar decisões sem redirecionar |
| `LOG_LEVEL` | Não | `info` | Nível de log |

*Obrigatória se houver rotas configuradas para Google (analysis, batch).

### Integrar com OpenClaw

No seu `~/.openclaw/openclaw.json`, aponte o provedor Anthropic para o ClawBridge:

```json
{
  "models": {
    "providers": {
      "anthropic": {
        "baseUrl": "http://127.0.0.1:8402"
      }
    }
  }
}
```

### Configuração

Toda a lógica de roteamento vive em arquivos JSON — sem necessidade de alterar código:

| Arquivo | Função |
|---|---|
| `config/routing.json` | Modelos, keywords, thresholds, fallback chain |
| `config/pricing.json` | Preço por modelo (input/output per 1M tokens) |
| `config/budget.json` | Budget mensal, thresholds de alerta/downgrade |
| `config/capabilities.json` | Capabilities por modelo, upgrade path |

### Privacidade

Requests com conteúdo sensível (keywords, PII, credenciais) são roteados para caminhos mais controlados e conservadores, com priorização de menor exposição operacional.

---

## English

Adaptive LLM routing decision engine for [OpenClaw](https://github.com/openclaw/openclaw). Sits between OpenClaw and LLM providers, classifying each request and routing it to the most suitable model by cost, capability, and performance.

### Why

With OpenClaw's default setup, every request goes to the same model. Heartbeat? Sonnet. Simple question? Sonnet. Complex architecture review? Also Sonnet.

ClawBridge fixes this with intelligent routing:
- **Cost-efficient**: cheap models for simple tasks, premium for complex ones
- **Progressive budget**: daily/weekly/monthly limits with automatic downgrade
- **Capability-aware**: detects tool_use, vision, long_context and auto-upgrades
- **SLO-aware**: per-model health scores with dynamic fallback reordering
- **Resilient**: automatic fallback on provider failures
- **Observable**: every decision is logged and explainable via endpoint

### Architecture

```
Telegram / CLI / Channel
         │
         ▼
OpenClaw Gateway (:18789)
         │
         ▼  (Anthropic-compatible API, POST /v1/messages)
   ClawBridge Proxy (:8402)
      ├─ privacy gate (keywords + PII regex)
      ├─ rules classifier (keyword scoring)
      ├─ budget check (progressive downgrade)
      ├─ capability check (automatic upgrade)
      └─ health-aware fallback (dynamic reordering)
         │
     ┌───┼───────────────┐
     ▼                   ▼
  Cloud A             Cloud B
  Anthropic           Google Gemini
```

### Model Tiers

All tiers are configurable in `config/routing.json`:

| Tier | Category | Default Model | Use Case |
|---|---|---|---|
| T1 | Complex | Anthropic Sonnet | Architecture, strategy, trade-offs |
| T2 | Analysis | Google Gemini Flash | Summarize, compare, evaluate |
| T3 | Action | Anthropic Haiku | Rewrite, format, transform |
| T4 | Batch | Google Gemini Flash Lite | Extract, classify, parse |
| T5 | Private Simple | Anthropic Haiku | Sensitive content, low complexity |
| T6 | Private Complex | Anthropic Sonnet | Sensitive content, high complexity |

### Routing Policy

1. **Privacy gate** (always first) — keywords, PII patterns, credential patterns → conservative route
2. **Rules classifier** — keyword scoring per category
3. **Budget check** — progressive downgrade based on spend (daily → weekly → monthly)
4. **Capability check** — if request needs tool_use/vision the model lacks → auto-upgrade
5. **Health-aware fallback** — fallback chain reordered by recent health scores
6. **Fallback chain** — on 429/5xx/timeout, try next provider automatically

### Setup

```bash
# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your API keys

# Verify configuration
npm run doctor

# Run
npm run dev

# Test
npm test
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `8402` | Proxy listen port |
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key |
| `ANTHROPIC_BASE_URL` | No | `https://api.anthropic.com` | Anthropic API base URL |
| `GOOGLE_API_KEY` | Yes* | — | Google AI API key |
| `SHADOW_MODE` | No | `false` | Log decisions without rerouting |
| `LOG_LEVEL` | No | `info` | Log verbosity |

*Required only if you have routes configured for Google (analysis, batch).

### Integrate with OpenClaw

In your `~/.openclaw/openclaw.json`, point the Anthropic provider to ClawBridge:

```json
{
  "models": {
    "providers": {
      "anthropic": {
        "baseUrl": "http://127.0.0.1:8402"
      }
    }
  }
}
```

### Configuration

All routing logic lives in JSON files — no code changes needed:

| File | Purpose |
|---|---|
| `config/routing.json` | Models, keywords, thresholds, fallback chain |
| `config/pricing.json` | Price per model (input/output per 1M tokens) |
| `config/budget.json` | Monthly budget, alert/downgrade thresholds |
| `config/capabilities.json` | Per-model capabilities, upgrade path |

### Privacy

Requests with sensitive content (keywords, PII, credentials) are routed to more controlled and conservative paths, prioritizing lower operational exposure.

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/v1/messages` | Main proxy route (Anthropic-compatible) |
| GET | `/health` | Server status, uptime |
| GET | `/v1/clawbridge/models` | Configured models and categories |
| GET | `/v1/clawbridge/usage` | Usage summary (tokens, cost, by model/category) |
| GET | `/v1/clawbridge/usage/raw?limit=N` | Raw usage records |
| GET | `/v1/clawbridge/budget` | Budget status (spend, pacing, spikes, level) |
| GET | `/v1/clawbridge/budget/regret` | Budget downgrade regret stats |
| GET | `/v1/clawbridge/health` | SLO health scores, dynamic fallback order |
| POST | `/v1/clawbridge/route/explain` | Dry-run routing with full decision trace |
| * | `/*` | Passthrough to Anthropic |

## Tests

```bash
npm test            # Run all tests (103 tests, 7 suites)
npm run test:watch  # Watch mode
npm run doctor      # Deployment diagnostics
```

## Project Structure

```
clawbridge/
  config/
    routing.json         # Routing policy (models, keywords, thresholds)
    pricing.json         # Model pricing (per 1M tokens)
    budget.json          # Budget limits and downgrade map
    capabilities.json    # Model capabilities and upgrade path
  src/
    server.ts            # HTTP proxy server + management endpoints
    router.ts            # Routing orchestrator (6 steps)
    classifier_rules.ts  # Deterministic keyword classifier
    classifier_t0.ts     # LLM classifier (optional)
    upstream.ts          # Protocol translation (Anthropic ↔ Google)
    fallback.ts          # Fallback chain execution with retry
    budget.ts            # Budget tracking, spike detection, downgrade
    capabilities.ts      # Capability detection and auto-upgrade
    health.ts            # SLO health tracker, dynamic fallback reordering
    usage.ts             # Usage tracking (JSONL storage, cost calculation)
    config.ts            # Configuration loader (.env + JSON configs)
    doctor.ts            # Deployment diagnostics CLI
    logger.ts            # Structured JSON logger
    token_estimator.ts   # Token count heuristic
    types.ts             # TypeScript types
  tests/
    router.test.ts
    classifier_rules.test.ts
    fallback.test.ts
    budget.test.ts
    usage.test.ts
    capabilities.test.ts
    health.test.ts
```

## License

MIT
