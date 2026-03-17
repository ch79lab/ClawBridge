// ═══════════════════════════════════════════════════════════
// ClawBridge — Types
// ═══════════════════════════════════════════════════════════

export type Category =
  | 'complex'
  | 'analysis'
  | 'action'
  | 'batch'
  | 'private_simple'
  | 'private_complex';

export const CATEGORIES: readonly Category[] = [
  'complex',
  'analysis',
  'action',
  'batch',
  'private_simple',
  'private_complex',
] as const;

export type Upstream = 'ollama' | 'anthropic' | 'google';

// ── Classifier ──────────────────────────────────────────────

export interface ClassifierResult {
  category: Category;
  confidence: number;
  rules_hit: string[];
}

// ── Routing Decision ────────────────────────────────────────

export interface RoutingDecision {
  category: Category;
  model: string;
  upstream: Upstream;
  timeoutMs: number;
  thinking: boolean;
  confidence: number;
  fallback_chain: FallbackStep[];
  decision_trace: DecisionTrace;
}

export interface FallbackStep {
  model: string;
  upstream: Upstream;
  timeoutMs: number;
}

export interface DecisionTrace {
  privacy_gate: boolean;
  privacy_reason?: string;
  rules_hit: string[];
  classifier_used: boolean;
  t0_category?: Category;
  t0_latency_ms?: number;
  escalated?: boolean;
  original_category?: Category;
}

// ── Config (routing.json shape) ─────────────────────────────

export interface RouteConfig {
  model: string;
  upstream: Upstream;
  timeoutMs: number;
  thinking: boolean;
}

export interface RoutingConfig {
  routes: Record<Category, RouteConfig>;
  fallback_chain: FallbackStep[];
  classifier: {
    rules_to_t0_threshold: number;
    escalation_threshold: number;
    t0_model: string;
    t0_timeout_ms: number;
  };
  privacy: {
    keywords: string[];
    pii_regexes: string[];
    sensitive_patterns: string[];
    complexity_keywords: string[];
  };
  rules: {
    complex: string[];
    analysis: string[];
    action: string[];
    batch: string[];
  };
}

// ── Anthropic API types (subset) ────────────────────────────

export interface AnthropicMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface AnthropicRequestBody {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens?: number;
  temperature?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
  [key: string]: unknown;
}

// ── Upstream result ─────────────────────────────────────────

export interface UpstreamResult {
  ok: boolean;
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  error?: string;
}

// ── Usage tracking ──────────────────────────────────────────

export interface UsageRecord {
  ts: string;
  request_id: string;
  category: Category;
  upstream: Upstream;
  model: string;
  primary_model: string;
  fallback_used: boolean;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  token_source: 'actual' | 'estimate';
  cost_input: number;
  cost_output: number;
  cost_total: number;
  piped: boolean;
}

export interface PricingConfig {
  models: Record<string, { input_per_1m: number; output_per_1m: number }>;
  default: { input_per_1m: number; output_per_1m: number };
}

// ── Log entry ───────────────────────────────────────────────

export interface LogEntry {
  ts: string;
  request_id: string;
  category: Category;
  confidence: number;
  primary_model: string;
  final_model: string;
  fallback_used: boolean;
  fallback_steps: number;
  latency_ms: number;
  t0_latency_ms?: number;
  token_estimate_in: number;
  error?: string;
  decision_trace: DecisionTrace;
}
