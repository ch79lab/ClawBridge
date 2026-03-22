# ClawBridge

> **[Português](#português)** · **[English](#english)**

---

## Português

Decision engine de roteamento adaptativo de LLMs para [OpenClaw](https://github.com/openclaw/openclaw). Senta entre o OpenClaw e os provedores de LLM, classificando cada request e roteando para o modelo mais adequado por custo, capability e performance.

### Por que usar

Com a configuração padrão do OpenClaw, todo request vai para o mesmo modelo. Heartbeat? Sonnet. Pergunta simples? Sonnet. Revisão de arquitetura complexa? Sonnet também.

ClawBridge resolve isso com roteamento inteligente:
- **Custo eficiente**: modelos baratos para tarefas simples, premium para complexas
- **Multi-provider**: Anthropic, Google e OpenRouter num único pipeline
- **Budget progressivo**: limites diários/semanais/mensais com downgrade automático
- **Capability-aware**: detecta tool_use, vision, long_context e faz upgrade automático
- **SLO-aware**: health score por modelo com reordenação dinâmica de fallback
- **Rate limiting**: caps por tier (hourly/daily) com fallback automático
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
      ├─ classificador short-circuit (privacy → vision → batch → domain)
      ├─ metadata stripping (remove metadados OpenClaw/Telegram)
      ├─ escalation (baixa confiança → tier superior)
      ├─ rate limit check (caps por tier)
      ├─ budget check (downgrade progressivo)
      ├─ capability check (upgrade automático)
      └─ health-aware fallback (reordenação dinâmica)
         │
     ┌───┼───────────────┬───────────────┐
     ▼                   ▼               ▼
  Anthropic           Google          OpenRouter
  Haiku, Sonnet    Gemini Flash,     Grok, MiniMax
                   Flash-Lite, Pro
```

### Tiers de Modelo

10 tiers configuráveis em `config/routing.json`:

| Tier | Categoria | Modelo | Provider | Custo (in→out/1M) |
|---|---|---|---|---|
| Default | `default` | Grok 4.1 Fast | OpenRouter | $0.20→$0.50 |
| Action | `action` | Claude Haiku 4-5 | Anthropic | $1→$5 |
| Complex | `complex` | Claude Sonnet 4-6 | Anthropic | $3→$15 |
| Analysis | `analysis` | Gemini 2.5 Flash | Google | $0.15→$0.60 |
| Batch | `batch` | Gemini 2.5 Flash-Lite | Google | $0.05→$0.20 |
| Vision | `vision` | Gemini 2.5 Flash | Google | $0.15→$0.60 |
| Code | `code` | MiniMax M2.5 | OpenRouter | $0.30→$1.20 |
| Deep Analysis | `deep_analysis` | Gemini 3.1 Pro | Google | $2→$12 |
| Private Simple | `private_simple` | Claude Haiku 4-5 | Anthropic | $1→$5 |
| Private Complex | `private_complex` | Claude Sonnet 4-6 | Anthropic | $3→$15 |

### Política de Roteamento

1. **Privacy gate** (sempre primeiro) — keywords, padrões PII, padrões de credenciais → rota conservadora (Anthropic)
2. **Image detection** — content blocks com imagem → vision tier
3. **Batch detection** — 2+ keywords de batch → batch tier
4. **Domain classification** — code, analysis, action, reasoning → tier correspondente
5. **Escalation** — confiança baixa → tier superior (nunca downgrade quando incerto)
6. **Rate limit** — tier no cap → fallback map
7. **Budget check** — downgrade progressivo baseado em gasto
8. **Capability check** — se request exige tool_use/vision que o modelo não suporta → upgrade automático
9. **Health-aware fallback** — cadeia de fallback reordenada por health score recente
10. **Fallback chain** — em 429/5xx/timeout, tenta o próximo provedor automaticamente

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
| `GOOGLE_API_KEY` | Sim* | — | API key Google AI |
| `OPENROUTER_API_KEY` | Sim* | — | API key OpenRouter |
| `SHADOW_MODE` | Não | `false` | Logar decisões sem redirecionar |
| `LOG_LEVEL` | Não | `info` | Nível de log |

*Obrigatória se houver rotas configuradas para o respectivo provider.

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
| `config/auth.json` | Auth por provider (API key, Bearer, URL param) |
| `config/rate-limits.json` | Rate limits por tier (hourly/daily caps) |

### Privacidade

Requests com conteúdo sensível (keywords, PII, credenciais) são roteados para caminhos mais controlados e conservadores (Anthropic), com priorização de menor exposição operacional.

---

## English

Adaptive LLM routing decision engine for [OpenClaw](https://github.com/openclaw/openclaw). Sits between OpenClaw and LLM providers, classifying each request and routing it to the most suitable model by cost, capability, and performance.

### Why

With OpenClaw's default setup, every request goes to the same model. Heartbeat? Sonnet. Simple question? Sonnet. Complex architecture review? Also Sonnet.

ClawBridge fixes this with intelligent routing:
- **Cost-efficient**: cheap models for simple tasks, premium for complex ones
- **Multi-provider**: Anthropic, Google and OpenRouter in a single pipeline
- **Progressive budget**: daily/weekly/monthly limits with automatic downgrade
- **Capability-aware**: detects tool_use, vision, long_context and auto-upgrades
- **SLO-aware**: per-model health scores with dynamic fallback reordering
- **Rate limiting**: per-tier caps (hourly/daily) with automatic fallback
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
      ├─ short-circuit classifier (privacy → vision → batch → domain)
      ├─ metadata stripping (strips OpenClaw/Telegram metadata)
      ├─ escalation (low confidence → higher tier)
      ├─ rate limit check (per-tier caps)
      ├─ budget check (progressive downgrade)
      ├─ capability check (automatic upgrade)
      └─ health-aware fallback (dynamic reordering)
         │
     ┌───┼───────────────┬───────────────┐
     ▼                   ▼               ▼
  Anthropic           Google          OpenRouter
  Haiku, Sonnet    Gemini Flash,     Grok, MiniMax
                   Flash-Lite, Pro
```

### Model Tiers

10 tiers configurable in `config/routing.json`:

| Tier | Category | Model | Provider | Cost (in→out/1M) |
|---|---|---|---|---|
| Default | `default` | Grok 4.1 Fast | OpenRouter | $0.20→$0.50 |
| Action | `action` | Claude Haiku 4-5 | Anthropic | $1→$5 |
| Complex | `complex` | Claude Sonnet 4-6 | Anthropic | $3→$15 |
| Analysis | `analysis` | Gemini 2.5 Flash | Google | $0.15→$0.60 |
| Batch | `batch` | Gemini 2.5 Flash-Lite | Google | $0.05→$0.20 |
| Vision | `vision` | Gemini 2.5 Flash | Google | $0.15→$0.60 |
| Code | `code` | MiniMax M2.5 | OpenRouter | $0.30→$1.20 |
| Deep Analysis | `deep_analysis` | Gemini 3.1 Pro | Google | $2→$12 |
| Private Simple | `private_simple` | Claude Haiku 4-5 | Anthropic | $1→$5 |
| Private Complex | `private_complex` | Claude Sonnet 4-6 | Anthropic | $3→$15 |

### Routing Policy

1. **Privacy gate** (always first) — keywords, PII patterns, credential patterns → conservative route (Anthropic)
2. **Image detection** — image content blocks → vision tier
3. **Batch detection** — 2+ batch keywords → batch tier
4. **Domain classification** — code, analysis, action, reasoning → matching tier
5. **Escalation** — low confidence → higher tier (never downgrade when uncertain)
6. **Rate limit** — tier at cap → fallback map
7. **Budget check** — progressive downgrade based on spend
8. **Capability check** — if request needs tool_use/vision the model lacks → auto-upgrade
9. **Health-aware fallback** — fallback chain reordered by recent health scores
10. **Fallback chain** — on 429/5xx/timeout, try next provider automatically

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
| `GOOGLE_API_KEY` | Yes* | — | Google AI API key |
| `OPENROUTER_API_KEY` | Yes* | — | OpenRouter API key |
| `SHADOW_MODE` | No | `false` | Log decisions without rerouting |
| `LOG_LEVEL` | No | `info` | Log verbosity |

*Required only if you have routes configured for the respective provider.

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
| `config/auth.json` | Per-provider auth (API key, Bearer, URL param) |
| `config/rate-limits.json` | Per-tier rate limits (hourly/daily caps) |

### Privacy

Requests with sensitive content (keywords, PII, credentials) are routed to more controlled and conservative paths (Anthropic), prioritizing lower operational exposure.

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
| GET | `/v1/clawbridge/health` | SLO health scores, dynamic fallback order |
| GET | `/v1/clawbridge/rate-limits` | Rate limit status per tier |
| POST | `/v1/clawbridge/route/explain` | Dry-run routing with full decision trace |
| * | `/*` | Passthrough to Anthropic |

## Tests

```bash
npm test            # Run all tests (133 tests, 9 suites)
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
    auth.json            # Per-provider authentication
    rate-limits.json     # Per-tier rate limits
  src/
    server.ts            # HTTP proxy server + management endpoints
    router.ts            # Routing orchestrator (10 steps)
    classifier_rules.ts  # Short-circuit keyword classifier
    classifier_t0.ts     # LLM classifier (optional, disabled)
    upstream.ts          # Protocol translation (Anthropic ↔ Google ↔ OpenAI-compat)
    fallback.ts          # Fallback chain execution with retry
    budget.ts            # Budget tracking, spike detection, downgrade
    capabilities.ts      # Capability detection and auto-upgrade
    health.ts            # SLO health tracker, dynamic fallback reordering
    rate-limiter.ts      # Per-tier rate limiting (hourly/daily)
    auth.ts              # Multi-provider auth (API key, Bearer, URL param)
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
    auth.test.ts
    openai-upstream.test.ts
```

## License

MIT
