import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getProviderAuth, resolveCredential, buildAuthHeaders, buildAuthUrlParam } from '../src/auth.js';
import type { AuthConfig, ProviderAuthConfig } from '../src/types.js';

describe('getProviderAuth', () => {
  const config: AuthConfig = {
    providers: {
      anthropic: { method: 'api_key', credential_env: 'ANTHROPIC_API_KEY', header: 'x-api-key' },
      openai: { method: 'oauth', credential_env: 'OPENAI_TOKEN', header: 'authorization_bearer' },
      google: { method: 'api_key', credential_env: 'GOOGLE_API_KEY', header: 'url_param' },
    },
  };

  it('returns provider config when it exists', () => {
    const result = getProviderAuth('anthropic', config);
    expect(result).toEqual({ method: 'api_key', credential_env: 'ANTHROPIC_API_KEY', header: 'x-api-key' });
  });

  it('returns null for unknown provider', () => {
    expect(getProviderAuth('unknown', config)).toBeNull();
  });

  it('returns null when config is null', () => {
    expect(getProviderAuth('anthropic', null)).toBeNull();
  });
});

describe('resolveCredential', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('returns env var value when set', () => {
    process.env.TEST_KEY = 'my-secret-key';
    const auth: ProviderAuthConfig = { method: 'api_key', credential_env: 'TEST_KEY', header: 'x-api-key' };
    expect(resolveCredential(auth)).toBe('my-secret-key');
  });

  it('throws when env var is not set', () => {
    delete process.env.MISSING_KEY;
    const auth: ProviderAuthConfig = { method: 'api_key', credential_env: 'MISSING_KEY', header: 'x-api-key' };
    expect(() => resolveCredential(auth)).toThrow('[AUTH] MISSING_KEY not set');
  });
});

describe('buildAuthHeaders', () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env.TEST_CRED = 'test-credential-value';
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('builds x-api-key header', () => {
    const auth: ProviderAuthConfig = { method: 'api_key', credential_env: 'TEST_CRED', header: 'x-api-key' };
    expect(buildAuthHeaders(auth)).toEqual({ 'x-api-key': 'test-credential-value' });
  });

  it('builds Authorization Bearer header', () => {
    const auth: ProviderAuthConfig = { method: 'token', credential_env: 'TEST_CRED', header: 'authorization_bearer' };
    expect(buildAuthHeaders(auth)).toEqual({ 'Authorization': 'Bearer test-credential-value' });
  });

  it('returns empty headers for url_param', () => {
    const auth: ProviderAuthConfig = { method: 'api_key', credential_env: 'TEST_CRED', header: 'url_param' };
    expect(buildAuthHeaders(auth)).toEqual({});
  });

  it('method field is metadata only — does not affect header output', () => {
    const asApiKey: ProviderAuthConfig = { method: 'api_key', credential_env: 'TEST_CRED', header: 'authorization_bearer' };
    const asOauth: ProviderAuthConfig = { method: 'oauth', credential_env: 'TEST_CRED', header: 'authorization_bearer' };
    expect(buildAuthHeaders(asApiKey)).toEqual(buildAuthHeaders(asOauth));
  });
});

describe('buildAuthUrlParam', () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env.TEST_CRED = 'my-google-key';
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('returns key=value for url_param header type', () => {
    const auth: ProviderAuthConfig = { method: 'api_key', credential_env: 'TEST_CRED', header: 'url_param' };
    expect(buildAuthUrlParam(auth)).toBe('key=my-google-key');
  });

  it('returns empty string for non-url_param header types', () => {
    const auth: ProviderAuthConfig = { method: 'api_key', credential_env: 'TEST_CRED', header: 'x-api-key' };
    expect(buildAuthUrlParam(auth)).toBe('');
  });
});
