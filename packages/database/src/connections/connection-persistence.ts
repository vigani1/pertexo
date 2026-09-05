import { createHash } from 'node:crypto';

import type { Pool } from 'pg';
import type { DatabaseError, PoolClient } from 'pg';
import { z } from 'zod';

import { withTenantScopedClient } from '../tenant-access/workspace.js';

/**
 * Shared connection persistence vocabulary and transaction mechanics.
 * Lifecycle SQL belongs in the focused persistence modules; this module owns
 * validation, row mapping, authorization checks, and durable result codecs.
 */

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
export const errorCodeSchema = z
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
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
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
  traceId?: string;
}>;

export type AssertConnectionSecretCurrentInput = Readonly<{
  workspaceId: string;
  connectionId: string;
  expectedProviderKey: string;
  expectedAuthType: ConnectionAuthType;
  secretVersionId: string;
}>;

export type RecordConnectionHealthInput = RequestMetadata &
  Readonly<{
    workspaceId: string;
    actorKind: 'user' | 'worker' | 'system';
    actorId: string;
    connectionId: string;
    result:
      | Readonly<{ ok: true }>
      | Readonly<{
          ok: false;
          errorCode: string;
          reauthorizationRequired?: boolean;
        }>;
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
  recordConnectionHealth(
    input: RecordConnectionHealthInput,
  ): Promise<ConnectionRecord>;
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

/** API capability plus the lifecycle operation owned by its runtime factory. */
export type ApiConnectionDatabase = ConnectionManagementDatabase &
  ConnectionTestDatabase &
  Pick<ConnectionDatabase, 'close'>;

/** Worker resolution capability plus the lifecycle operation owned by its runtime factory. */
export type WorkerConnectionResolutionDatabase = ConnectionResolutionDatabase &
  Pick<ConnectionDatabase, 'close'>;

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
): Promise<T> {
  const workspaceId = uuidSchema.parse(workspaceIdInput);
  return withTenantScopedClient(
    pool,
    actorId === undefined
      ? { workspaceId }
      : { workspaceId, actorId: identifierSchema.parse(actorId) },
    (client) => operation(client, workspaceId),
  );
}

export async function requireConnectionManager(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
): Promise<void> {
  const result = await client.query(
    `select 1 from app.workspace_memberships membership
     join app.workspaces workspace on workspace.id = membership.workspace_id
     join app.users actor on actor.id = membership.user_id
     where membership.workspace_id = $1 and membership.user_id = $2
       and membership.status = 'active'
       and membership.role in ('owner', 'admin')
       and workspace.status = 'active' and actor.status = 'active'`,
    [workspaceId, uuidSchema.parse(actorId)],
  );
  if (result.rowCount !== 1)
    throw new ConnectionNotFoundError('Connection is not visible');
}

export async function requireConnectionUser(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
): Promise<void> {
  const result = await client.query(
    `select 1 from app.workspace_memberships membership
     join app.workspaces workspace on workspace.id = membership.workspace_id
     join app.users actor on actor.id = membership.user_id
     where membership.workspace_id = $1 and membership.user_id = $2
       and membership.status = 'active'
       and membership.role in ('owner', 'admin', 'builder', 'operator')
       and workspace.status = 'active' and actor.status = 'active'`,
    [workspaceId, uuidSchema.parse(actorId)],
  );
  if (result.rowCount !== 1)
    throw new ConnectionNotFoundError('Connection is not visible');
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
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as DatabaseError).code === '23505' &&
    (error as DatabaseError).constraint === constraint
  );
}

export function durableCreateResult(value: unknown): Readonly<{
  connectionId: string;
  secretVersionId: string;
}> {
  return z
    .object({ connectionId: z.uuid(), secretVersionId: z.uuid() })
    .strict()
    .parse(value);
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
    createdBy: z.uuid(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export function durableConnectionSnapshot(
  value: unknown,
): ConnectionRecord | null {
  const parsed = durableConnectionSnapshotSchema.safeParse(value);
  if (!parsed.success) return null;
  return Object.freeze({
    ...parsed.data,
    lastTestedAt:
      parsed.data.lastTestedAt === null
        ? null
        : new Date(parsed.data.lastTestedAt),
    lastHealthyAt:
      parsed.data.lastHealthyAt === null
        ? null
        : new Date(parsed.data.lastHealthyAt),
    createdAt: new Date(parsed.data.createdAt),
    updatedAt: new Date(parsed.data.updatedAt),
  });
}

export function serializeConnectionSnapshot(
  connection: ConnectionRecord,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...connection,
    lastTestedAt: connection.lastTestedAt?.toISOString() ?? null,
    lastHealthyAt: connection.lastHealthyAt?.toISOString() ?? null,
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
  const connection = durableConnectionSnapshot(parsed.connection);
  if (connection === null)
    throw new Error('Connection test idempotency result is corrupt');
  return Object.freeze({ connection, outcome: parsed.outcome });
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

export function connectionTestScope(
  actorId: string,
  connectionId: string,
): string {
  return `${uuidSchema.parse(actorId)}:${uuidSchema.parse(connectionId)}`;
}

export function connectionTestClaim(
  dispatchToken: string,
  state: 'claimed' | 'dispatched',
) {
  return Object.freeze({
    schemaVersion: 1,
    state,
    dispatchToken: uuidSchema.parse(dispatchToken),
  });
}

export const connectionTestClaimSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.enum(['claimed', 'dispatched']),
    dispatchToken: z.uuid(),
  })
  .strict();
