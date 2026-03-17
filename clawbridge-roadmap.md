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

- classificação ainda parece simples demais para workloads ambíguos
- capabilities reais dos modelos não estão formalizadas em um registry explícito
- fallback tende a ser mais linear do que contextual
- custo ainda tende a ser tratado por heurística, não por política formal
- performance observada ainda não parece ser o principal insumo da decisão
- setup e debugging ainda geram atrito excessivo
- a semântica de `private_*` ficou mais fraca após remoção do local execution

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

## Fase 0 — Core Hardening

### Objetivo
Estabilizar o núcleo antes de sofisticar a decisão.

### Entregas
- revisar a semântica e nomenclatura de `private_simple` e `private_complex`
- revisar README e mensagens do produto para remover promessas de privacidade local
- corrigir thresholds e pesos do classificador atual
- formalizar interface de adapters por provider
- padronizar tratamento de erro por upstream
- garantir compatibilidade de protocolo ponta a ponta
- registrar decisão de rota, fallback, latência e custo estimado

### Critérios de saída
- requests principais funcionando com estabilidade
- zero ambiguidade documental sobre o que `private_*` significa
- logs suficientes para entender por que uma rota foi escolhida
- fallback básico confiável

### Prioridade
Máxima

---

## Fase 0.5 — Deployment & Debug Simplification

### Objetivo
Reduzir brutalmente o tempo gasto em setup, ajuste manual e troubleshooting.

### Problema que esta fase resolve
Você já validou na prática que o custo cognitivo de implantação está alto demais:
- muito copiar e colar
- muito ajuste manual
- muito trial-and-error
- muito tempo navegando em logs e fontes para entender falhas

Isso não é mais “parte natural do processo”; já virou backlog de produto.

### Entregas
- `clawbridge init`
  - gera `.env`
  - gera `routing.json` inicial
  - oferece perfil recomendado
- `clawbridge doctor`
  - valida env vars
  - valida conectividade com providers
  - valida existência dos modelos configurados
  - testa rota mínima end-to-end
- `clawbridge validate-config`
  - identifica conflito de configuração
  - alerta sobre categorias sem fallback
  - alerta sobre policy inconsistente
- starter profile opinado
  - configuração mínima para primeiro request funcionar rápido
- quickstart real de 5 minutos
- mensagens de erro acionáveis
  - erro
  - provável causa
  - ação sugerida

### Critérios de saída
- tempo para primeiro request funcional cai drasticamente
- onboarding deixa de depender de leitura longa e caça manual de configuração
- erros mais comuns ficam diagnosticáveis sem inspeção profunda de código

### Prioridade
Muito alta

---

## Fase 1 — Capability-Aware Router

### Objetivo
Sair de roteamento apenas por categoria e passar a decidir por capacidade exigida.

### Problema que esta fase resolve
Categoria é abstração fraca demais. O request precisa ser traduzido em necessidades reais de execução.

### Entregas
- `capability_registry`
  - reasoning strength
  - latency profile
  - cost tier
  - context window
  - JSON reliability
  - code-edit reliability
  - tool-use support
  - sensitivity suitability
- extração de capabilities por request
- shortlist por capability antes da decisão final
- `route_explainer`
  - explica por que a rota foi escolhida
- distinção entre:
  - task complexity
  - execution complexity

### Exemplo de decisão melhor
Em vez de:
- “isso é analysis”

Passa a ser:
- “isso exige reasoning médio, latência baixa, output estruturado e custo moderado”

### Critérios de saída
- decisões menos arbitrárias
- menor erro em casos ambíguos
- explicação clara da decisão

### Prioridade
Alta

---

## Fase 2 — Economic Router

### Objetivo
Transformar custo em policy explícita, não em consequência implícita.

### Entregas
- cost ceilings por categoria/capability
- custo estimado por request
- custo real observado por rota
- score de eficiência econômica
- detecção de:
  - modelo caro desnecessário
  - barato errado com retry posterior
- regret tracking inicial
  - retry rate
  - fallback rate
  - escalation after first answer
  - override rate

### Perguntas que o produto precisa responder
- quanto economizou?
- onde economizou errado?
- onde um modelo melhor teria evitado retry?
- onde um modelo mais barato teria resolvido igual?

### Critérios de saída
- economia mensurável
- visibilidade de regret
- decisões de custo menos intuitivas e mais evidentes

### Prioridade
Alta

---

## Fase 3 — SLO-Aware Router

### Objetivo
Garantir performance com base em dados recentes de execução.

### Entregas
- `execution_score` por rota/modelo
- health score baseado em:
  - TTFT
  - latência total
  - taxa de erro
  - taxa de fallback
  - estabilidade recente
- fallback matrix por tipo de erro
  - timeout
  - 429
  - incompatibilidade de capability
  - erro transitório
- reordenação dinâmica de fallback
- política de degradação graciosa

### Fórmula conceitual
A decisão passa a considerar:
- qualidade esperada
- custo esperado
- health score recente

### Critérios de saída
- menos rotas ruins por indisponibilidade momentânea
- melhor estabilidade operacional
- menor latência média percebida

### Prioridade
Alta

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

1. Fase 0 — Core Hardening
2. Fase 0.5 — Deployment & Debug Simplification
3. Fase 1 — Capability-Aware Router
4. Fase 2 — Economic Router
5. Fase 3 — SLO-Aware Router
6. Fase 4 — Session-Aware Router
7. Fase 5 — Outcome-Aware Learning
8. Fase 6 — Specialized Agent Router

---

## Backlog imediato recomendado

## Bloco A — fazer agora

- revisar documentação e semântica de `private_*`
- criar `capability_registry`
- criar `route_explainer`
- instrumentar métricas mínimas
- criar `clawbridge doctor`
- criar `validate-config`
- publicar starter profile

## Bloco B — fazer em seguida

- cost ceilings
- regret tracking
- execution score
- fallback matrix por erro
- quickstart de 5 minutos realmente funcional

## Bloco C — depois

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
