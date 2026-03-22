// ═══════════════════════════════════════════════════════════
// ClawBridge — Types
// ═══════════════════════════════════════════════════════════

export type Category =
  | 'default'
  | 'complex'
  | 'analysis'
  | 'action'
  | 'batch'
  | 'private_simple'
  | 'private_complex'
  | 'vision'
  | 'code'
  | 'deep_analysis';

export const CATEGORIES: readonly Category[] = [
  'default',
  'complex',
  'analysis',
  'action',
  'batch',
  'private_simple',
  'private_complex',
  'vision',
  'code',
  'deep_analysis',
] as const;

export type Upstream = 'ollama' | 'anthropic' | 'google' | 'openai';

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
  budget_downgrade?: boolean;
  budget_original_model?: string;
  budget_level?: string;
  capability_upgrade?: boolean;
  capability_original_model?: string;
  capability_required?: string[];
  capability_missing?: string[];
  fallback_reordered?: boolean;
  primary_health_score?: number;
  rate_limited?: boolean;
  rate_limit_tier?: string;
  rate_limit_fallback?: string;
  domain_detected?: string;
  token_threshold_exceeded?: boolean;
}

// ── Config (routing.json shape) ─────────────────────────────

export interface RouteConfig {
  model: string;
  upstream: Upstream;
  timeoutMs: number;
  thinking: boolean;
}

export interface RoutingConfig {
  routes: Record<string, RouteConfig>;
  fallback_chain: FallbackStep[];
  fallback_map?: Record<string, FallbackStep>;
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
    complexity_keywords: string[];  // used only for private_simple vs private_complex
  };
  rules: Record<string, string[]>;  // includes 'reasoning' for domain detection
}

// ── Rate Limiting ────────────────────────────────────────

export interface TierRateLimit {
  hourly: number;
  daily: number;
}

export interface RateLimitConfig {
  tiers: Partial<Record<string, TierRateLimit>>;
  oauth_global: TierRateLimit;
  oauth_tiers: string[];
  oauth_priority: string[];
}

export interface RateLimitStatus {
  tier: string;
  hourly_used: number;
  hourly_limit: number;
  daily_used: number;
  daily_limit: number;
  blocked: boolean;
  oauth_hourly_used: number;
  oauth_daily_used: number;
  oauth_blocked: boolean;
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
  budget_downgraded?: boolean;
}

export interface PricingConfig {
  models: Record<string, { input_per_1m: number; output_per_1m: number }>;
  default: { input_per_1m: number; output_per_1m: number };
}

// ── Budget ──────────────────────────────────────────────────

export interface BudgetConfig {
  monthly_budget_usd: number;
  warn_threshold_pct: number;
  downgrade_threshold_pct: number;
  hard_stop_pct: number;
  spike_daily_multiplier: number;
  spike_weekly_multiplier: number;
  downgrade_map: Record<string, string>;
}

export interface BudgetStatus {
  monthly_budget_usd: number;
  daily_limit_usd: number;
  weekly_limit_usd: number;
  daily_spend_usd: number;
  weekly_spend_usd: number;
  monthly_spend_usd: number;
  daily_pct: number;
  weekly_pct: number;
  monthly_pct: number;
  pacing_expected_usd: number;
  pacing_actual_usd: number;
  pacing_pct: number;
  level: 'normal' | 'warn' | 'downgrade' | 'hard_stop';
  alerts: string[];
  spike_daily: boolean;
  spike_weekly: boolean;
}

export interface RegretStats {
  total_requests: number;
  budget_downgrades: number;
  downgrade_pct: number;
  downgrade_fallback_count: number;
  downgrade_fallback_pct: number;
}

// ── Health / SLO ────────────────────────────────────────

export interface ModelHealth {
  model: string;
  upstream: Upstream;
  // Sliding window stats
  window_size: number;
  success_count: number;
  failure_count: number;
  success_rate: number;       // 0-1
  // Latency percentiles (ms)
  latency_p50: number;
  latency_p95: number;
  latency_avg: number;
  // Composite score (0-1, higher = healthier)
  health_score: number;
  // Last seen
  last_success_ts?: string;
  last_failure_ts?: string;
  last_error?: string;
}

export interface HealthStatus {
  models: ModelHealth[];
  fallback_order: Array<{ model: string; upstream: Upstream; health_score: number }>;
}

// ── Capabilities ────────────────────────────────────────

export type Capability = 'tool_use' | 'vision' | 'long_context' | 'code' | 'multilingual' | 'thinking';

export interface ModelCapabilities {
  capabilities: Capability[];
  max_context_tokens: number;
  max_output_tokens: number;
  strengths: string[];
  tier: number; // 1=cheapest, 3=most capable
}

export interface CapabilitiesConfig {
  models: Record<string, ModelCapabilities>;
  request_detection: {
    tool_use: { check: string; description: string };
    vision: { check: string; description: string };
    long_context: { token_threshold: number; description: string };
  };
  upgrade_path: Record<string, string>;
}

export interface CapabilityCheck {
  required: Capability[];
  missing: Capability[];
  upgrade_needed: boolean;
  upgraded_model?: string;
  upgraded_upstream?: Upstream;
  reason?: string;
}

// ── Route explanation ───────────────────────────────────

export interface RouteExplanation {
  input_summary: {
    last_message_preview: string;
    message_count: number;
    has_tools: boolean;
    has_images: boolean;
    estimated_tokens: number;
  };
  classification: {
    category: Category;
    confidence: number;
    rules_hit: string[];
    privacy_detected: boolean;
  };
  routing: {
    model: string;
    upstream: Upstream;
    reason: string;
  };
  capabilities: {
    required: Capability[];
    model_has: Capability[];
    upgrade_applied: boolean;
    upgrade_reason?: string;
  };
  budget: {
    level: string;
    downgrade_applied: boolean;
    original_model?: string;
  };
  fallback_chain: Array<{ model: string; upstream: Upstream }>;
}

// ── Auth ────────────────────────────────────────────────────

export type AuthMethod = 'api_key' | 'token' | 'oauth';
export type AuthHeaderType = 'x-api-key' | 'authorization_bearer' | 'url_param';

export interface ProviderAuthConfig {
  method: AuthMethod;
  credential_env: string;
  header: AuthHeaderType;
}

export interface AuthConfig {
  providers: Record<string, ProviderAuthConfig>;
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
