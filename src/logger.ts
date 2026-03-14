// ═══════════════════════════════════════════════════════════
// ClawBridge — Structured JSON Logger
// ═══════════════════════════════════════════════════════════

import { AsyncLocalStorage } from 'node:async_hooks';

const requestContext = new AsyncLocalStorage<{ requestId: string }>();

export function withRequestContext<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}

function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

type LogLevel = 'info' | 'warn' | 'error';

function write(level: LogLevel, fields: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    request_id: getRequestId(),
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const log = {
  info: (fields: Record<string, unknown>) => write('info', fields),
  warn: (fields: Record<string, unknown>) => write('warn', fields),
  error: (fields: Record<string, unknown>) => write('error', fields),
};
