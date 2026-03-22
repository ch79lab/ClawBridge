// ═══════════════════════════════════════════════════════════
// ClawBridge — Provider Authentication
// ═══════════════════════════════════════════════════════════

import type { AuthConfig, ProviderAuthConfig } from './types.js';

export function getProviderAuth(upstream: string, config: AuthConfig | null): ProviderAuthConfig | null {
  if (!config) return null;
  return config.providers[upstream] || null;
}

export function resolveCredential(providerAuth: ProviderAuthConfig): string {
  const value = process.env[providerAuth.credential_env];
  if (!value) throw new Error(`[AUTH] ${providerAuth.credential_env} not set`);
  return value;
}

export function buildAuthHeaders(providerAuth: ProviderAuthConfig): Record<string, string> {
  const credential = resolveCredential(providerAuth);
  switch (providerAuth.header) {
    case 'x-api-key':
      return { 'x-api-key': credential };
    case 'authorization_bearer':
      return { 'Authorization': `Bearer ${credential}` };
    case 'url_param':
      return {}; // handled at URL level via buildAuthUrlParam
    default:
      return { 'x-api-key': credential };
  }
}

export function buildAuthUrlParam(providerAuth: ProviderAuthConfig): string {
  if (providerAuth.header !== 'url_param') return '';
  return `key=${resolveCredential(providerAuth)}`;
}
