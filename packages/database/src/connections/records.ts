import { createHash } from 'node:crypto';

import {
  connectionHealthSnapshotSchema,
  deserializeConnectionHealthMetadata,
  mapConnectionHealthMetadata,
} from './health/metadata.js';

import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { withTenantScopedClient } from '../tenant-access/transactions.js';
import type { WorkspaceTransactionOptions } from '../tenant-access/transactions.js';

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
    schemaVersion: z.literal(1),
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

export const CONNECTION_STATUS = {
  active: 'active',
  reauthorizationRequired: 'reauthorization_required',
  revoked: 'revoked',
} as const;
export type ConnectionStatus =
  (typeof CONNECTION_STATUS)[keyof typeof CONNECTION_STATUS];

export const CONNECTION_AUTH_TYPE = {
  httpHeaders: 'http_headers',
  slackBotToken: 'slack_bot_token',
  resendApiKey: 'resend_api_key',
} as const;
export type ConnectionAuthType =
  (typeof CONNECTION_AUTH_TYPE)[keyof typeof CONNECTION_AUTH_TYPE];

export const CONNECTION_EVENT_TYPE = {
  created: 'connection.created',
  secretRotated: 'connection.secret_rotated',
  testSucceeded: 'connection.test_succeeded',
  testFailed: 'connection.test_failed',
  reauthorizationRequired: 'connection.reauthorization_required',
  revoked: 'connection.revoked',
  credentialAccessed: 'connection.credential_accessed',
} as const;

export type SealedConnectionSecretRecord = Readonly<
  z.output<typeof sealedSecretSchema>
>;

export type ConnectionRecord = Readonly<{
  id: string;
  workspaceId: string;
  providerKey: string;
  name: string;
  authType: ConnectionAuthType;
  status: ConnectionStatus;
  currentSecretVersionId: string;
  lastTestedAt: Date | null;
  lastHealthyAt: Date | null;
  lastErrorCode: string | null;
  lastRunObservedAt?: Date | null;
  lastHealthTransitionAt?: Date | null;
  lastHealthTransitionSource?: 'run' | 'test' | 'rotation' | 'revoke' | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}>;

export type ListConnectionsInput = Readonly<{
  workspaceId: string;
  actorId: string;
  limit?: number;
  after?: Readonly<{
    status: ConnectionStatus;
    createdAt: string;
    id: string;
  }>;
}>;

export type ConnectionPage = Readonly<{
  items: readonly ConnectionRecord[];
  nextCursor?: Readonly<{
    status: ConnectionStatus;
    createdAt: string;
    id: string;
  }>;
}>;

export type ReadConnectionInput = Readonly<{
  workspaceId: string;
  actorId: string;
  connectionId: string;
}>;

export type ResolvedConnectionSecretRecord = Readonly<{
  connection: ConnectionRecord;
  secretVersionId: string;
  sealed: SealedConnectionSecretRecord;
}>;

export type RequestMetadata = Readonly<{
  requestId?: string;
  traceId?: string;
}>;

export type CreateConnectionInput = RequestMetadata &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
    secretVersionId: string;
    providerKey: string;
    name: string;
    authType: ConnectionAuthType;
    sealed: SealedConnectionSecretRecord;
    idempotencyKey: string;
    requestHash: string;
  }>;

export type FindConnectionCreateReplayInput = Readonly<{
  workspaceId: string;
  actorId: string;
  idempotencyKey: string;
  requestHash: string;
}>;

export type FindConnectionRotateReplayInput = Readonly<{
  workspaceId: string;
  actorId: string;
  connectionId: string;
  idempotencyKey: string;
  requestHash: string;
}>;

export type RotateConnectionSecretInput = RequestMetadata &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
    secretVersionId: string;
    expectedCurrentSecretVersionId: string;
    expectedAuthType?: ConnectionAuthType;
    sealed: SealedConnectionSecretRecord;
    idempotencyKey: string;
    requestHash: string;
  }>;

export type RevokeConnectionInput = RequestMetadata &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
  }>;

export type ResolveConnectionSecretInput = Readonly<{
  workspaceId: string;
  connectionId: string;
  expectedProviderKey: string;
  workerId: string;
  purpose: string;
  signal?: AbortSignal;
  traceId?: string;
}>;

export type AssertConnectionSecretCurrentInput = Readonly<{
  workspaceId: string;
  connectionId: string;
  expectedProviderKey: string;
  expectedAuthType: ConnectionAuthType;
  secretVersionId: string;
  signal?: AbortSignal;
}>;

export type ConnectionTestOutcome =
  | Readonly<{ ok: true; httpStatus: number }>
  | Readonly<{
      ok: false;
      httpStatus: number | null;
      errorCode: string;
      reauthorizationRequired: boolean;
    }>;

export type ConnectionTestResult = Readonly<{
  connection: ConnectionRecord;
  outcome: ConnectionTestOutcome;
}>;

export type StartConnectionTestInput = RequestMetadata &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
    expectedProviderKey: string;
    idempotencyKey: string;
    requestHash: string;
    dispatchToken: string;
  }>;

export type StartConnectionTestResult =
  | Readonly<{ kind: 'replay'; result: ConnectionTestResult }>
  | Readonly<{
      kind: 'dispatch';
      dispatchToken: string;
    }>;

export type ResolveConnectionTestSecretInput = RequestMetadata &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
    expectedProviderKey: string;
    idempotencyKey: string;
    requestHash: string;
    dispatchToken: string;
  }>;

export type MarkConnectionTestDispatchedInput = RequestMetadata &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
    idempotencyKey: string;
    requestHash: string;
    dispatchToken: string;
    secretVersionId: string;
  }>;

export type CompleteConnectionTestInput = RequestMetadata &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
    idempotencyKey: string;
    requestHash: string;
    dispatchToken: string;
    secretVersionId: string;
    outcome: ConnectionTestOutcome;
  }>;

export type AbandonConnectionTestInput = Readonly<{
  workspaceId: string;
  actorId: string;
  connectionId: string;
  idempotencyKey: string;
  requestHash: string;
  dispatchToken: string;
}>;

export interface ConnectionDatabase {
  listConnections(input: ListConnectionsInput): Promise<ConnectionPage>;
  readConnection(input: ReadConnectionInput): Promise<ConnectionRecord | null>;
  createConnection(input: CreateConnectionInput): Promise<ConnectionRecord>;
  findConnectionCreateReplay(
    input: FindConnectionCreateReplayInput,
  ): Promise<ConnectionRecord | null>;
  findConnectionRotateReplay(
    input: FindConnectionRotateReplayInput,
  ): Promise<ConnectionRecord | null>;
  getConnection(
    workspaceId: string,
    connectionId: string,
  ): Promise<ConnectionRecord | null>;
  rotateConnectionSecret(
    input: RotateConnectionSecretInput,
  ): Promise<ConnectionRecord>;
  revokeConnection(input: RevokeConnectionInput): Promise<ConnectionRecord>;
  resolveConnectionSecret(
    input: ResolveConnectionSecretInput,
  ): Promise<ResolvedConnectionSecretRecord>;
  assertConnectionSecretCurrent(
    input: AssertConnectionSecretCurrentInput,
  ): Promise<void>;
  startConnectionTest(
    input: StartConnectionTestInput,
  ): Promise<StartConnectionTestResult>;
  resolveConnectionTestSecret(
    input: ResolveConnectionTestSecretInput,
  ): Promise<ResolvedConnectionSecretRecord>;
  markConnectionTestDispatched(
    input: MarkConnectionTestDispatchedInput,
  ): Promise<void>;
  completeConnectionTest(
    input: CompleteConnectionTestInput,
  ): Promise<ConnectionTestResult>;
  abandonConnectionTest(input: AbandonConnectionTestInput): Promise<void>;
  close(): Promise<void>;
}

/**
 * API connection commands and their idempotency lookups.
 *
 * This view deliberately excludes secret resolution and worker-only health
 * operations.  The implementation remains shared by the role-specific
 * factories below, but callers receive only the behavior they own.
 */
export type ConnectionManagementDatabase = Pick<
  ConnectionDatabase,
  | 'createConnection'
  | 'findConnectionCreateReplay'
  | 'findConnectionRotateReplay'
  | 'rotateConnectionSecret'
  | 'revokeConnection'
>;

/** Safe metadata reads for authenticated API consumers. */
export type ConnectionReadDatabase = Pick<
  ConnectionDatabase,
  'listConnections' | 'readConnection'
>;

/** API-owned connection-test state transitions. */
export type ConnectionTestDatabase = Pick<
  ConnectionDatabase,
  | 'startConnectionTest'
  | 'resolveConnectionTestSecret'
  | 'markConnectionTestDispatched'
  | 'completeConnectionTest'
  | 'abandonConnectionTest'
>;

/** The only connection behavior required by a worker node executor. */
export type ConnectionResolutionDatabase = Pick<
  ConnectionDatabase,
  'assertConnectionSecretCurrent' | 'resolveConnectionSecret'
>;

export class ConnectionNotFoundError extends Error {
  public override readonly name = 'ConnectionNotFoundError';
}

export class ConnectionConflictError extends Error {
  public override readonly name = 'ConnectionConflictError';
}

export class ConnectionIdempotencyConflictError extends Error {
  public override readonly name = 'ConnectionIdempotencyConflictError';
}

export class ConnectionUnavailableError extends Error {
  public override readonly name = 'ConnectionUnavailableError';
}

export class ConnectionSecretVersionConflictError extends Error {
  public override readonly name = 'ConnectionSecretVersionConflictError';
}

export class ConnectionTestInProgressError extends Error {
  public override readonly name = 'ConnectionTestInProgressError';
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

export function mapConnection(
  row: Readonly<Record<string, unknown>>,
): ConnectionRecord {
  return Object.freeze({
    id: uuidSchema.parse(row.id),
    workspaceId: uuidSchema.parse(row.workspace_id),
    providerKey: providerKeySchema.parse(row.provider_key),
    name: connectionNameSchema.parse(row.name),
    authType: z.enum(CONNECTION_AUTH_TYPE).parse(row.auth_type),
    status: z.enum(CONNECTION_STATUS).parse(row.status),
    currentSecretVersionId: uuidSchema.parse(row.current_secret_version_id),
    lastTestedAt:
      row.last_tested_at === null ? null : z.date().parse(row.last_tested_at),
    lastHealthyAt:
      row.last_healthy_at === null ? null : z.date().parse(row.last_healthy_at),
    lastErrorCode:
      row.last_error_code === null
        ? null
        : errorCodeSchema.parse(row.last_error_code),
    ...mapConnectionHealthMetadata(row),
    createdBy: uuidSchema.parse(row.created_by),
    createdAt: z.date().parse(row.created_at),
    updatedAt: z.date().parse(row.updated_at),
  });
}

export function mapSealed(row: Readonly<Record<string, unknown>>) {
  return sealedSecretSchema.parse({
    schemaVersion: row.schema_version,
    kmsKeyReference: row.kms_key_reference,
    encryptedDataKey: row.encrypted_data_key,
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    tag: row.auth_tag,
  });
}

export async function withConnectionTransaction<T>(
  pool: Pool,
  workspaceIdInput: string,
  actorId: string | undefined,
  operation: (client: PoolClient, workspaceId: string) => Promise<T>,
  options: WorkspaceTransactionOptions = {},
): Promise<T> {
  const workspaceId = uuidSchema.parse(workspaceIdInput);
  return withTenantScopedClient(
    pool,
    actorId === undefined
      ? { workspaceId }
      : { workspaceId, actorId: identifierSchema.parse(actorId) },
    async (client) => {
      await client.query('select app.lock_workspace_run_admission($1)', [
        workspaceId,
      ]);
      return operation(client, workspaceId);
    },
    options,
  );
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

export async function selectConnection(
  client: PoolClient,
  workspaceId: string,
  connectionId: string,
  lock = false,
): Promise<ConnectionRecord | null> {
  const result = await client.query<Record<string, unknown>>(
    `select * from app.connections
     where workspace_id = $1 and id = $2${lock ? ' for update' : ''}`,
    [workspaceId, uuidSchema.parse(connectionId)],
  );
  return result.rows[0] === undefined ? null : mapConnection(result.rows[0]);
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
    schemaVersion: z.literal(1),
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
    schemaVersion: 1,
    connection: serializeConnectionSnapshot(result.connection),
    outcome: result.outcome,
  });
}
