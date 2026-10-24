import { createHash } from 'node:crypto';
import {
  connectionHealthSnapshotSchema,
  deserializeConnectionHealthMetadata,
} from './health/metadata.js';

import { z } from 'zod';
import { sha256HexSchema as digestSchema } from '../platform/persisted-primitives.js';

import {
  CONNECTION_STATUS,
  CONNECTION_AUTH_TYPE,
  type ConnectionRecord,
  type RequestMetadata,
  type ConnectionTestResult,
  ConnectionIdempotencyConflictError,
} from './contract.js';

export const uuidSchema = z.uuid();

export const providerKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);

export const connectionNameSchema = z.string().trim().min(1).max(128);

const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u)
  .refine((value) => !value.includes(','));

export const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u);

const requestIdentifierSchema = z.string().min(1).max(128);

const errorCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9._:-]{0,127}$/u);

export const sealedSecretSchema = z
  .object({
    kmsKeyReference: z.string().min(1).max(2048),
    encryptedDataKey: z
      .string()
      .min(1)
      .max(10_923)
      .regex(/^[A-Za-z0-9_-]+$/u),
    ciphertext: z
      .string()
      .min(1)
      .max(87_382)
      .regex(/^[A-Za-z0-9_-]+$/u),
    nonce: z
      .string()
      .length(16)
      .regex(/^[A-Za-z0-9_-]+$/u),
    tag: z
      .string()
      .length(22)
      .regex(/^[A-Za-z0-9_-]+$/u),
  })
  .strict();

/** One connection command under its idempotency key and request digest. */
export function connectionCommand(
  input: Readonly<{ idempotencyKey: string; requestHash: string }>,
  workspaceId: string,
  operation: string,
  scope: string,
) {
  return {
    workspaceId,
    operation,
    scope,
    idempotencyKey: idempotencyKeySchema.parse(input.idempotencyKey),
    requestHash: digestSchema.parse(input.requestHash),
    conflict: () =>
      new ConnectionIdempotencyConflictError(
        'Idempotency key request mismatch',
      ),
  };
}

export function keyDigest(value: string): string {
  return createHash('sha256')
    .update(idempotencyKeySchema.parse(value))
    .digest('hex');
}

export function safeOptionalIdentifier(
  value: string | undefined,
): string | null {
  return value === undefined ? null : requestIdentifierSchema.parse(value);
}

export function parseRequestMetadata(input: RequestMetadata): Readonly<{
  requestId: string | null;
  traceId: string | null;
}> {
  return Object.freeze({
    requestId: safeOptionalIdentifier(input.requestId),
    traceId: safeOptionalIdentifier(input.traceId),
  });
}

export function databaseConstraint(
  error: unknown,
  constraint: string,
): boolean {
  try {
    if (error === null || typeof error !== 'object') return false;
    const code: unknown = Reflect.get(error, 'code');
    const actualConstraint: unknown = Reflect.get(error, 'constraint');
    return (
      code === '23505' &&
      typeof actualConstraint === 'string' &&
      actualConstraint.length <= 128 &&
      actualConstraint === constraint
    );
  } catch {
    return false;
  }
}

const durableConnectionSnapshotSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    providerKey: providerKeySchema,
    name: connectionNameSchema,
    authType: z.enum(CONNECTION_AUTH_TYPE),
    status: z.enum(CONNECTION_STATUS),
    currentSecretVersionId: z.uuid(),
    lastTestedAt: z.iso.datetime().nullable(),
    lastHealthyAt: z.iso.datetime().nullable(),
    lastErrorCode: errorCodeSchema.nullable(),
    ...connectionHealthSnapshotSchema.shape,
    createdBy: z.uuid(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    // Receipts stored before sharing existed describe workspace-wide connections.
    accessMode: z.enum(['workspace', 'restricted']).default('workspace'),
  })
  .strict();

/** The connection a completed command stored for exact retries. */
export function decodeDurableConnectionReplay(
  value: unknown,
): ConnectionRecord {
  const parsed = durableConnectionSnapshotSchema.parse(value);
  return Object.freeze({
    ...parsed,
    lastTestedAt:
      parsed.lastTestedAt === null ? null : new Date(parsed.lastTestedAt),
    lastHealthyAt:
      parsed.lastHealthyAt === null ? null : new Date(parsed.lastHealthyAt),
    ...deserializeConnectionHealthMetadata(parsed),
    createdAt: new Date(parsed.createdAt),
    updatedAt: new Date(parsed.updatedAt),
  });
}

export function serializeConnectionSnapshot(
  connection: ConnectionRecord,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...connection,
    lastTestedAt: connection.lastTestedAt?.toISOString() ?? null,
    lastHealthyAt: connection.lastHealthyAt?.toISOString() ?? null,
    lastRunObservedAt: connection.lastRunObservedAt?.toISOString() ?? null,
    lastHealthTransitionAt:
      connection.lastHealthTransitionAt?.toISOString() ?? null,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  });
}

export const connectionTestOutcomeSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      httpStatus: z.number().int().min(100).max(599),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      httpStatus: z.number().int().min(100).max(599).nullable(),
      errorCode: errorCodeSchema,
      reauthorizationRequired: z.boolean(),
    })
    .strict(),
]);

const durableConnectionTestResultSchema = z
  .object({
    connection: durableConnectionSnapshotSchema,
    outcome: connectionTestOutcomeSchema,
  })
  .strict();

export function parseConnectionTestResult(
  value: unknown,
): ConnectionTestResult {
  const parsed = durableConnectionTestResultSchema.parse(value);
  return Object.freeze({
    connection: decodeDurableConnectionReplay(parsed.connection),
    outcome: parsed.outcome,
  });
}

export function serializeConnectionTestResult(
  result: ConnectionTestResult,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    connection: serializeConnectionSnapshot(result.connection),
    outcome: result.outcome,
  });
}
