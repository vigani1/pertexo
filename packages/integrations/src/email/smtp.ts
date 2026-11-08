import type { smtpCredentialSchema } from '@pertexo/contracts';
import type { z } from 'zod';
import type { ResendClient } from './client.js';
import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';
import { failure } from './failure.js';

export type SmtpCredential = z.output<typeof smtpCredentialSchema>;
export type SmtpEmailResult =
  | Readonly<{ kind: 'submitted'; reference: string }>
  | Readonly<{
      kind: 'failed' | 'retryable' | 'unknown';
      failure: Readonly<{ category: string }>;
    }>;
export type SmtpEmailClient = Readonly<{
  sendNotification(
    credential: SmtpCredential,
    message: Omit<Parameters<ResendClient['sendNotification']>[0], 'apiKey'>,
  ): Promise<SmtpEmailResult>;
}>;

export function requireSmtpAccepted(
  result: SmtpEmailResult,
  runtime: NodeExecutionRuntime,
): void {
  if (result.kind === 'submitted') return;
  const unknown =
    result.kind === 'unknown' || (runtime.providerDispatchUnresolved ?? false);
  const definiteOutcome = result.kind === 'retryable' ? 'retry' : 'failed';
  throw failure(
    unknown ? 'outcome_unknown' : definiteOutcome,
    result.failure.category === 'authentication'
      ? 'authentication'
      : 'provider',
    { possiblyDispatched: unknown },
  );
}
