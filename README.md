# ClawBridge

> **[Português](#português)** · **[English](#english)**

---

## Português

Proxy de roteamento adaptativo de LLMs para [OpenClaw](https://github.com/openclaw/openclaw). Senta entre o OpenClaw e os provedores de LLM, classificando cada request e roteando para o modelo mais barato capaz de executar a tarefa.

### Por que usar

Com a configuração padrão do OpenClaw, todo request vai para o mesmo modelo. Heartbeat? Sonnet. Pergunta simples? Sonnet. Revisão de arquitetura complexa? Sonnet também.

ClawBridge resolve isso com roteamento determinístico:
- **Privacidade primeiro**: conteúdo sensível nunca sai da sua máquina
- **Custo eficiente**: modelos baratos para tarefas simples, premium para complexas
- **Resiliente**: fallback automático quando um provedor falha
- **Observável**: toda decisão de roteamento é logada

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
      └─ classificador T0 LLM (Ollama local, opcional)
         │
     ┌───┼───────────────┐
     ▼   ▼               ▼
  Local    Cloud A      Cloud B
  Ollama   Anthropic    Google Gemini
```

ClawBridge intercepta requests `POST /v1/messages` do OpenClaw, classifica e faz proxy para o upstream correto. O OpenClaw não precisa de nenhuma mudança de código — basta apontar a base URL do Anthropic para o ClawBridge.

### Tiers de Modelo

Todos os tiers são configuráveis em `config/routing.json`:

| Tier | Categoria | Modelo Padrão | Uso |
|---|---|---|---|
| T1 | Complex | Anthropic Sonnet | Arquitetura, estratégia, trade-offs |
| T2 | Analysis | Google Gemini Flash | Resumir, comparar, avaliar |
| T3 | Action | Anthropic Haiku | Reescrever, formatar, transformar |
| T4 | Batch | Google Gemini Flash Lite | Extrair, classificar, parsear |
| T5 | Private | Modelo local Ollama | Conteúdo sensível (nunca sai da máquina) |

### Política de Roteamento

1. **Privacy gate** (sempre primeiro) — keywords, padrões PII, padrões de credenciais → forçar local
2. **Classificador por regras** — scoring de keywords por categoria
3. **Classificador T0 LLM** — se confiança das regras < threshold, pergunta a um modelo local
4. **Escalação por confiança** — confiança baixa → escalar para tier mais seguro (mais capaz)
5. **Cadeia de fallback** — em 429/5xx/timeout, tenta o próximo provedor automaticamente

### Instalação

```bash
# Instalar dependências
npm install

# Configurar
cp .env.example .env
# Edite .env com suas API keys

# Garantir que Ollama está rodando com seu modelo local preferido
ollama pull qwen3.5:9b  # ou qualquer modelo que preferir

# Rodar
npm run dev

# Testar
npm test
```

### Variáveis de Ambiente

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `PORT` | Não | `8402` | Porta do proxy |
| `OLLAMA_URL` | Não | `http://localhost:11434` | Endpoint da API Ollama |
| `ANTHROPIC_API_KEY` | Sim* | — | API key Anthropic |
| `ANTHROPIC_BASE_URL` | Não | `https://api.anthropic.com` | URL base API Anthropic |
| `GOOGLE_API_KEY` | Sim* | — | API key Google AI |
| `SHADOW_MODE` | Não | `false` | Logar decisões sem redirecionar |
| `LOG_LEVEL` | Não | `info` | Nível de log |

*Obrigatória apenas se houver rotas configuradas para o provedor.

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

Reinicie o OpenClaw após alterar o config. Todos os requests passam pelo ClawBridge de forma transparente.

### Configuração

Toda a lógica de roteamento vive em `config/routing.json` — sem necessidade de alterar código para:
- Adicionar/remover modelos
- Mudar atribuições de tier
- Ajustar keywords (suporta qualquer idioma)
- Ajustar thresholds de confiança
- Modificar cadeias de fallback
- Adicionar padrões PII

### Shadow Mode

Defina `SHADOW_MODE=true` para logar decisões de roteamento sem redirecionar. Requests passam direto para o upstream padrão. Útil para validar a precisão da classificação antes de ativar.

### Privacidade

Quando o privacy gate é ativado (keywords sensíveis, padrões PII ou padrões de credenciais detectados):
- Request é **sempre** roteado para o modelo local
- Conteúdo **nunca** sai da sua máquina
- Nenhuma API cloud é chamada

---

## English

Adaptive LLM routing proxy for [OpenClaw](https://github.com/openclaw/openclaw). Sits between OpenClaw and LLM providers, classifying each request and routing it to the cheapest capable model.

### Why

With OpenClaw's default setup, every request goes to the same model. Heartbeat? Sonnet. Simple question? Sonnet. Complex architecture review? Also Sonnet.

ClawBridge fixes this with deterministic routing:
- **Privacy-first**: sensitive content never leaves your machine
- **Cost-efficient**: cheap models for simple tasks, premium for complex ones
- **Resilient**: automatic fallback on provider failures
- **Observable**: every routing decision is logged

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
      └─ T0 LLM classifier (local Ollama, optional)
         │
     ┌───┼───────────────┐
     ▼   ▼               ▼
  Local    Cloud A      Cloud B
  Ollama   Anthropic    Google Gemini
```

ClawBridge intercepts `POST /v1/messages` requests from OpenClaw, classifies them, and proxies to the right upstream. OpenClaw doesn't need any code changes — just point its Anthropic base URL to ClawBridge.

### Model Tiers

All tiers are configurable in `config/routing.json`:

| Tier | Category | Default Model | Use Case |
|---|---|---|---|
| T1 | Complex | Anthropic Sonnet | Architecture, strategy, trade-offs |
| T2 | Analysis | Google Gemini Flash | Summarize, compare, evaluate |
| T3 | Action | Anthropic Haiku | Rewrite, format, transform |
| T4 | Batch | Google Gemini Flash Lite | Extract, classify, parse |
| T5 | Private | Local Ollama model | Sensitive content (never leaves machine) |

### Routing Policy

1. **Privacy gate** (always first) — keywords, PII patterns, credential patterns → force local
2. **Rules classifier** — keyword scoring per category
3. **T0 LLM classifier** — if rules confidence < threshold, ask a local model
4. **Confidence escalation** — low confidence → escalate to safer (more capable) tier
5. **Fallback chain** — on 429/5xx/timeout, try next provider automatically

### Setup

```bash
# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your API keys

# Ensure Ollama is running with your preferred local model
ollama pull qwen3.5:9b  # or any model you prefer

# Run
npm run dev

# Test
npm test
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `8402` | Proxy listen port |
| `OLLAMA_URL` | No | `http://localhost:11434` | Ollama API endpoint |
| `ANTHROPIC_API_KEY` | Yes* | — | Anthropic API key |
| `ANTHROPIC_BASE_URL` | No | `https://api.anthropic.com` | Anthropic API base URL |
| `GOOGLE_API_KEY` | Yes* | — | Google AI API key |
| `SHADOW_MODE` | No | `false` | Log decisions without rerouting |
| `LOG_LEVEL` | No | `info` | Log verbosity |

*Required only if you have routes configured for that provider.

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

Restart OpenClaw after changing the config. All requests now flow through ClawBridge transparently.

### Configuration

All routing logic lives in `config/routing.json` — no code changes needed to:
- Add/remove models
- Change tier assignments
- Tune keywords (supports any language)
- Adjust confidence thresholds
- Modify fallback chains
- Add PII patterns

### Shadow Mode

Set `SHADOW_MODE=true` to log routing decisions without rerouting. Requests pass through to the default upstream. Useful for validating classification accuracy before going live.

### Privacy

When the privacy gate triggers (sensitive keywords, PII patterns, or credential patterns detected):
- Request is **always** routed to the local model
- Content **never** leaves your machine
- No cloud API is called

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/v1/messages` | Main proxy route (Anthropic-compatible) |
| GET | `/health` | Server status |
| * | `/*` | Passthrough to default upstream |

## Tests

```bash
npm test            # Run all tests
npm run test:watch  # Watch mode
```

## Project Structure

```
clawbridge/
  config/routing.json    # All routing policy (models, keywords, thresholds)
  src/
    server.ts            # HTTP proxy server
    router.ts            # Routing orchestrator
    classifier_rules.ts  # Deterministic keyword classifier
    classifier_t0.ts     # Local LLM classifier (Ollama)
    upstream.ts          # Protocol translation (Anthropic ↔ Ollama ↔ Google)
    fallback.ts          # Fallback chain execution
    config.ts            # Configuration loader
    logger.ts            # Structured JSON logger
    token_estimator.ts   # Token count heuristic
    types.ts             # TypeScript types
  tests/
    classifier_rules.test.ts
    router.test.ts
    fallback.test.ts
```

## Roadmap

- [ ] Session-aware routing (tier escalation within conversations)
- [ ] Budget tracking and daily/monthly limits
- [ ] Metrics dashboard
- [ ] Confidence scoring improvements (hybrid heuristic + LLM)
- [ ] Multi-agent domain routing

## License

MIT
