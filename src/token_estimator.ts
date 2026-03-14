// ═══════════════════════════════════════════════════════════
// ClawBridge — Token Estimator
// ═══════════════════════════════════════════════════════════

export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}
