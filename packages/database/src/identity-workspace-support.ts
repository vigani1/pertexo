import type { DatabaseError } from 'pg';
import { z } from 'zod';

import { IdempotencyRequestConflictError } from './execution-acceptance.js';
import {
  IdentityConflictError,
  WorkspaceLifecycleConflictError,
  type IdentityConflictReason,
} from './identity-workspace-errors.js';

const uuidSchema = z.uuid();
const metadataSchema = z
  .record(z.string(), z.json())
  .refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 8192);
const unsafeMetadataKey =
  /(?:password|secret|token|credential|verifier|nonce|private[_-]?key|authorization|cookie)/iu;

export function parseIdentityUuid(value: string): string {
  return uuidSchema.parse(value);
}

function assertSafeMetadata(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSafeMetadata(item);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (
        key === '__proto__' ||
        key === 'prototype' ||
        key === 'constructor' ||
        unsafeMetadataKey.test(key)
      )
        throw new Error('Unsafe audit metadata key');
      assertSafeMetadata(item);
    }
  }
}

export function parseIdentityMetadata(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const parsed = metadataSchema.parse(value ?? {});
  assertSafeMetadata(parsed);
  return parsed;
}

export function throwIdentityDatabaseConflict(
  error: unknown,
  message: string,
  reason: IdentityConflictReason = 'identity',
): never {
  const code =
    error instanceof Error ? (error as DatabaseError).code : undefined;
  if (code === '23505' || code === '23503' || code === '23514')
    throw new IdentityConflictError(message, { cause: error, reason });
  throw error;
}

export function throwWorkspaceLifecycleError(error: unknown): never {
  const code =
    error instanceof Error ? (error as DatabaseError).code : undefined;
  if (code === '23505') throw new IdempotencyRequestConflictError();
  if (code === '42501')
    throw new WorkspaceLifecycleConflictError(
      'actor_inactive',
      'Workspace lifecycle actor is not authorized',
      { cause: error },
    );
  if (code === '55000' || code === '23503')
    throw new WorkspaceLifecycleConflictError(
      'invalid_state',
      'Workspace lifecycle transition is not valid',
      { cause: error },
    );
  throw error;
}
