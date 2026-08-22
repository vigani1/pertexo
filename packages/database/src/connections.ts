import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { DatabaseError, PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from './config.js';

const uuidSchema = z.uuid();
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const providerKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);
const connectionNameSchema = z.string().trim().min(1).max(128);
const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u)
  .refine((value) => !value.includes(','));
const identifierSchema = z
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
const sealedSecretSchema = z
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

type RequestMetadata = Readonly<{
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

function keyDigest(value: string): string {
  return createHash('sha256')
    .update(idempotencyKeySchema.parse(value))
    .digest('hex');
}

function safeOptionalIdentifier(value: string | undefined): string | null {
  return value === undefined ? null : requestIdentifierSchema.parse(value);
}

function mapConnection(
  row: Readonly<Record<string, unknown>>,
): ConnectionRecord {
  return Object.freeze({
    id: uuidSchema.parse(row.id),
    workspaceId: uuidSchema.parse(row.workspace_id),
    providerKey: providerKeySchema.parse(row.provider_key),
    name: connectionNameSchema.parse(row.name),
    authType: z.literal(CONNECTION_AUTH_TYPE.httpHeaders).parse(row.auth_type),
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

function mapSealed(row: Readonly<Record<string, unknown>>) {
  return sealedSecretSchema.parse({
    schemaVersion: row.schema_version,
    kmsKeyReference: row.kms_key_reference,
    encryptedDataKey: row.encrypted_data_key,
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    tag: row.auth_tag,
  });
}

async function withConnectionTransaction<T>(
  pool: Pool,
  workspaceIdInput: string,
  actorId: string | undefined,
  operation: (client: PoolClient, workspaceId: string) => Promise<T>,
): Promise<T> {
  const workspaceId = uuidSchema.parse(workspaceIdInput);
  const parsedActorId =
    actorId === undefined ? undefined : identifierSchema.parse(actorId);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      actorId === undefined
        ? "select set_config('app.workspace_id', $1, true)"
        : "select set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true)",
      actorId === undefined ? [workspaceId] : [workspaceId, parsedActorId],
    );
    const result = await operation(client, workspaceId);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function requireConnectionManager(
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

async function requireConnectionUser(
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

function parseRequestMetadata(input: RequestMetadata): Readonly<{
  requestId: string | null;
  traceId: string | null;
}> {
  return Object.freeze({
    requestId: safeOptionalIdentifier(input.requestId),
    traceId: safeOptionalIdentifier(input.traceId),
  });
}

async function selectConnection(
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

function databaseConstraint(error: unknown, constraint: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as DatabaseError).code === '23505' &&
    (error as DatabaseError).constraint === constraint
  );
}

function durableCreateResult(value: unknown): Readonly<{
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
    authType: z.literal(CONNECTION_AUTH_TYPE.httpHeaders),
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

function durableConnectionSnapshot(value: unknown): ConnectionRecord | null {
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

function serializeConnectionSnapshot(
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

const connectionTestOutcomeSchema = z.discriminatedUnion('ok', [
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

function parseConnectionTestResult(value: unknown): ConnectionTestResult {
  const parsed = durableConnectionTestResultSchema.parse(value);
  const connection = durableConnectionSnapshot(parsed.connection);
  if (connection === null)
    throw new Error('Connection test idempotency result is corrupt');
  return Object.freeze({ connection, outcome: parsed.outcome });
}

function serializeConnectionTestResult(
  result: ConnectionTestResult,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: 1,
    connection: serializeConnectionSnapshot(result.connection),
    outcome: result.outcome,
  });
}

function connectionTestScope(actorId: string, connectionId: string): string {
  return `${uuidSchema.parse(actorId)}:${uuidSchema.parse(connectionId)}`;
}

function connectionTestClaim(
  dispatchToken: string,
  state: 'claimed' | 'dispatched',
) {
  return Object.freeze({
    schemaVersion: 1,
    state,
    dispatchToken: uuidSchema.parse(dispatchToken),
  });
}

const connectionTestClaimSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.enum(['claimed', 'dispatched']),
    dispatchToken: z.uuid(),
  })
  .strict();

export function createConnectionDatabase(
  config: DatabaseConfig,
): ConnectionDatabase {
  const pool = new Pool(config);
  const database: ConnectionDatabase = {
    createConnection: async (input): Promise<ConnectionRecord> => {
      const connectionId = uuidSchema.parse(input.connectionId);
      const secretVersionId = uuidSchema.parse(input.secretVersionId);
      const actorId = uuidSchema.parse(input.actorId);
      const providerKey = providerKeySchema.parse(input.providerKey);
      const name = connectionNameSchema.parse(input.name);
      const authType = z
        .literal(CONNECTION_AUTH_TYPE.httpHeaders)
        .parse(input.authType);
      const sealed = sealedSecretSchema.parse(input.sealed);
      const requestHash = digestSchema.parse(input.requestHash);
      const digest = keyDigest(input.idempotencyKey);
      const metadata = parseRequestMetadata(input);
      try {
        return await withConnectionTransaction(
          pool,
          input.workspaceId,
          actorId,
          async (client, workspaceId) => {
            await requireConnectionManager(client, workspaceId, actorId);
            await client.query(
              `insert into app.idempotency_records
                 (id, workspace_id, operation, scope, key_hash, request_hash,
                  status, resource_id, result_ref)
               values ($1, $2, 'connection.create', $3, $4, $5,
                       'in_progress', $6, '{}'::jsonb)
               on conflict (workspace_id, operation, scope, key_hash) do nothing`,
              [
                randomUUID(),
                workspaceId,
                actorId,
                digest,
                requestHash,
                connectionId,
              ],
            );
            const claim = await client.query<{
              request_hash: string;
              status: string;
              result_ref: unknown;
            }>(
              `select request_hash, status, result_ref
               from app.idempotency_records
               where workspace_id = $1 and operation = 'connection.create'
                 and scope = $2 and key_hash = $3 for update`,
              [workspaceId, actorId, digest],
            );
            const claimed = claim.rows[0];
            if (claimed === undefined)
              throw new Error('Connection idempotency claim is unavailable');
            if (claimed.request_hash !== requestHash)
              throw new ConnectionIdempotencyConflictError(
                'Idempotency key request mismatch',
              );
            if (claimed.status === 'completed') {
              const snapshot = durableConnectionSnapshot(claimed.result_ref);
              if (snapshot !== null) {
                if (snapshot.workspaceId !== workspaceId)
                  throw new Error('Connection idempotency result is corrupt');
                return snapshot;
              }
              const replay = durableCreateResult(claimed.result_ref);
              const existing = await selectConnection(
                client,
                workspaceId,
                replay.connectionId,
              );
              if (existing === null)
                throw new Error('Connection idempotency result is corrupt');
              return existing;
            }

            const inserted = await client.query<Record<string, unknown>>(
              `insert into app.connections
                 (id, workspace_id, provider_key, name, auth_type, status,
                  current_secret_version_id, created_by)
               values ($1, $2, $3, $4, $5, 'active', $6, $7)
               returning *`,
              [
                connectionId,
                workspaceId,
                providerKey,
                name,
                authType,
                secretVersionId,
                actorId,
              ],
            );
            const row = inserted.rows[0];
            if (row === undefined)
              throw new Error('Connection insert returned no row');
            const connection = mapConnection(row);
            await client.query(
              `insert into app.connection_secret_versions
                 (id, workspace_id, connection_id, schema_version,
                  kms_key_reference, encrypted_data_key, ciphertext, nonce,
                  auth_tag, created_by)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [
                secretVersionId,
                workspaceId,
                connectionId,
                sealed.schemaVersion,
                sealed.kmsKeyReference,
                sealed.encryptedDataKey,
                sealed.ciphertext,
                sealed.nonce,
                sealed.tag,
                actorId,
              ],
            );
            await client.query(
              `insert into app.connection_events
                 (id, workspace_id, connection_id, event_type, actor_kind,
                  actor_id, request_id, trace_id, metadata)
               values ($1, $2, $3, 'connection.created', 'user', $4, $5, $6,
                       $7::jsonb)`,
              [
                randomUUID(),
                workspaceId,
                connectionId,
                actorId,
                metadata.requestId,
                metadata.traceId,
                JSON.stringify({
                  providerKey,
                  authType,
                  secretVersionId,
                }),
              ],
            );
            await client.query(
              `insert into app.audit_events
                 (id, workspace_id, actor_user_id, action, target_type,
                  target_id, request_id, trace_id, metadata)
               values ($1, $2, $3, 'connection.created', 'connection', $4,
                       $5, $6, $7::jsonb)`,
              [
                randomUUID(),
                workspaceId,
                actorId,
                connectionId,
                metadata.requestId,
                metadata.traceId,
                JSON.stringify({ providerKey, authType, secretVersionId }),
              ],
            );
            await client.query(
              `update app.idempotency_records
               set status = 'completed', result_ref = $1::jsonb,
                   updated_at = transaction_timestamp()
               where workspace_id = $2 and operation = 'connection.create'
                 and scope = $3 and key_hash = $4`,
              [
                JSON.stringify(serializeConnectionSnapshot(connection)),
                workspaceId,
                actorId,
                digest,
              ],
            );
            return connection;
          },
        );
      } catch (error: unknown) {
        if (
          databaseConstraint(error, 'connections_active_name_provider_unique')
        )
          throw new ConnectionConflictError(
            'An active connection already uses this provider and name',
          );
        throw error;
      }
    },

    findConnectionCreateReplay: async (
      input,
    ): Promise<ConnectionRecord | null> => {
      const actorId = uuidSchema.parse(input.actorId);
      const requestHash = digestSchema.parse(input.requestHash);
      const digest = keyDigest(input.idempotencyKey);
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          await requireConnectionManager(client, workspaceId, actorId);
          const result = await client.query<{
            request_hash: string;
            status: string;
            result_ref: unknown;
          }>(
            `select request_hash, status, result_ref
             from app.idempotency_records
             where workspace_id = $1 and operation = 'connection.create'
               and scope = $2 and key_hash = $3`,
            [workspaceId, actorId, digest],
          );
          const record = result.rows[0];
          if (record === undefined) return null;
          if (record.request_hash !== requestHash)
            throw new ConnectionIdempotencyConflictError(
              'Idempotency key request mismatch',
            );
          if (record.status !== 'completed') return null;
          const snapshot = durableConnectionSnapshot(record.result_ref);
          if (snapshot !== null) {
            if (snapshot.workspaceId !== workspaceId)
              throw new Error('Connection idempotency result is corrupt');
            return snapshot;
          }
          const replay = durableCreateResult(record.result_ref);
          const connection = await selectConnection(
            client,
            workspaceId,
            replay.connectionId,
          );
          if (connection === null)
            throw new Error('Connection idempotency result is corrupt');
          return connection;
        },
      );
    },

    findConnectionRotateReplay: async (
      input,
    ): Promise<ConnectionRecord | null> => {
      const actorId = uuidSchema.parse(input.actorId);
      const connectionId = uuidSchema.parse(input.connectionId);
      const requestHash = digestSchema.parse(input.requestHash);
      const digest = keyDigest(input.idempotencyKey);
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          await requireConnectionManager(client, workspaceId, actorId);
          const scope = `${actorId}:${connectionId}`;
          const result = await client.query<{
            request_hash: string;
            status: string;
            result_ref: unknown;
          }>(
            `select request_hash, status, result_ref
             from app.idempotency_records
             where workspace_id = $1
               and operation = 'connection.secret.rotate'
               and scope = $2 and key_hash = $3`,
            [workspaceId, scope, digest],
          );
          const record = result.rows[0];
          if (record === undefined) return null;
          if (record.request_hash !== requestHash)
            throw new ConnectionIdempotencyConflictError(
              'Idempotency key request mismatch',
            );
          if (record.status !== 'completed') return null;
          const snapshot = durableConnectionSnapshot(record.result_ref);
          if (snapshot !== null) {
            if (
              snapshot.id !== connectionId ||
              snapshot.workspaceId !== workspaceId
            )
              throw new Error(
                'Connection rotation idempotency result is corrupt',
              );
            return snapshot;
          }
          const replay = durableCreateResult(record.result_ref);
          const connection = await selectConnection(
            client,
            workspaceId,
            replay.connectionId,
          );
          if (replay.connectionId !== connectionId || connection === null)
            throw new Error(
              'Connection rotation idempotency result is corrupt',
            );
          return connection;
        },
      );
    },

    getConnection: (workspaceId, connectionId) =>
      withConnectionTransaction(
        pool,
        workspaceId,
        undefined,
        (client, parsedWorkspaceId) =>
          selectConnection(client, parsedWorkspaceId, connectionId),
      ),

    rotateConnectionSecret: async (input): Promise<ConnectionRecord> => {
      const actorId = uuidSchema.parse(input.actorId);
      const connectionId = uuidSchema.parse(input.connectionId);
      const secretVersionId = uuidSchema.parse(input.secretVersionId);
      const expected = uuidSchema.parse(input.expectedCurrentSecretVersionId);
      const sealed = sealedSecretSchema.parse(input.sealed);
      const requestHash = digestSchema.parse(input.requestHash);
      const digest = keyDigest(input.idempotencyKey);
      const metadata = parseRequestMetadata(input);
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          await requireConnectionManager(client, workspaceId, actorId);
          const scope = `${actorId}:${connectionId}`;
          await client.query(
            `insert into app.idempotency_records
               (id, workspace_id, operation, scope, key_hash, request_hash,
                status, resource_id, result_ref)
             values ($1, $2, 'connection.secret.rotate', $3, $4, $5,
                     'in_progress', $6, '{}'::jsonb)
             on conflict (workspace_id, operation, scope, key_hash) do nothing`,
            [
              randomUUID(),
              workspaceId,
              scope,
              digest,
              requestHash,
              connectionId,
            ],
          );
          const claim = await client.query<{
            request_hash: string;
            status: string;
            result_ref: unknown;
          }>(
            `select request_hash, status, result_ref
             from app.idempotency_records
             where workspace_id = $1
               and operation = 'connection.secret.rotate'
               and scope = $2 and key_hash = $3 for update`,
            [workspaceId, scope, digest],
          );
          const claimed = claim.rows[0];
          if (claimed === undefined)
            throw new Error(
              'Connection rotation idempotency claim is unavailable',
            );
          if (claimed.request_hash !== requestHash)
            throw new ConnectionIdempotencyConflictError(
              'Idempotency key request mismatch',
            );
          if (claimed.status === 'completed') {
            const snapshot = durableConnectionSnapshot(claimed.result_ref);
            if (snapshot !== null) {
              if (
                snapshot.id !== connectionId ||
                snapshot.workspaceId !== workspaceId
              )
                throw new Error(
                  'Connection rotation idempotency result is corrupt',
                );
              return snapshot;
            }
            const replay = durableCreateResult(claimed.result_ref);
            const existing = await selectConnection(
              client,
              workspaceId,
              replay.connectionId,
            );
            if (existing === null || replay.connectionId !== connectionId)
              throw new Error(
                'Connection rotation idempotency result is corrupt',
              );
            return existing;
          }
          const connection = await selectConnection(
            client,
            workspaceId,
            connectionId,
            true,
          );
          if (connection === null)
            throw new ConnectionNotFoundError('Connection is not visible');
          if (connection.status === CONNECTION_STATUS.revoked)
            throw new ConnectionUnavailableError('Connection is revoked');
          if (connection.currentSecretVersionId !== expected)
            throw new ConnectionSecretVersionConflictError(
              'Connection secret version does not match',
            );
          await client.query(
            `insert into app.connection_secret_versions
               (id, workspace_id, connection_id, schema_version,
                kms_key_reference, encrypted_data_key, ciphertext, nonce,
                auth_tag, created_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              secretVersionId,
              workspaceId,
              connectionId,
              sealed.schemaVersion,
              sealed.kmsKeyReference,
              sealed.encryptedDataKey,
              sealed.ciphertext,
              sealed.nonce,
              sealed.tag,
              actorId,
            ],
          );
          const updated = await client.query<Record<string, unknown>>(
            `update app.connections
             set current_secret_version_id = $1, status = 'active',
                 last_error_code = null, updated_at = transaction_timestamp()
             where workspace_id = $2 and id = $3
             returning *`,
            [secretVersionId, workspaceId, connectionId],
          );
          await client.query(
            `insert into app.connection_events
               (id, workspace_id, connection_id, event_type, actor_kind,
                actor_id, request_id, trace_id, metadata)
             values ($1, $2, $3, 'connection.secret_rotated', 'user', $4,
                     $5, $6, $7::jsonb)`,
            [
              randomUUID(),
              workspaceId,
              connectionId,
              actorId,
              metadata.requestId,
              metadata.traceId,
              JSON.stringify({
                previousSecretVersionId: expected,
                secretVersionId,
              }),
            ],
          );
          const row = updated.rows[0];
          if (row === undefined)
            throw new Error('Connection rotation returned no row');
          const rotated = mapConnection(row);
          await client.query(
            `update app.idempotency_records
             set status = 'completed', result_ref = $1::jsonb,
                 updated_at = transaction_timestamp()
             where workspace_id = $2
               and operation = 'connection.secret.rotate'
               and scope = $3 and key_hash = $4`,
            [
              JSON.stringify(serializeConnectionSnapshot(rotated)),
              workspaceId,
              scope,
              digest,
            ],
          );
          return rotated;
        },
      );
    },

    revokeConnection: async (input): Promise<ConnectionRecord> => {
      const actorId = uuidSchema.parse(input.actorId);
      const connectionId = uuidSchema.parse(input.connectionId);
      const metadata = parseRequestMetadata(input);
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          await requireConnectionManager(client, workspaceId, actorId);
          const connection = await selectConnection(
            client,
            workspaceId,
            connectionId,
            true,
          );
          if (connection === null)
            throw new ConnectionNotFoundError('Connection is not visible');
          if (connection.status === CONNECTION_STATUS.revoked)
            return connection;
          const updated = await client.query<Record<string, unknown>>(
            `update app.connections
             set status = 'revoked', updated_at = transaction_timestamp()
             where workspace_id = $1 and id = $2 returning *`,
            [workspaceId, connectionId],
          );
          await client.query(
            `insert into app.connection_events
               (id, workspace_id, connection_id, event_type, actor_kind,
                actor_id, request_id, trace_id, metadata)
             values ($1, $2, $3, 'connection.revoked', 'user', $4, $5, $6,
                     '{}'::jsonb)`,
            [
              randomUUID(),
              workspaceId,
              connectionId,
              actorId,
              metadata.requestId,
              metadata.traceId,
            ],
          );
          const row = updated.rows[0];
          if (row === undefined)
            throw new Error('Connection revocation returned no row');
          return mapConnection(row);
        },
      );
    },

    resolveConnectionSecret: async (
      input,
    ): Promise<ResolvedConnectionSecretRecord> => {
      const connectionId = uuidSchema.parse(input.connectionId);
      const expectedProviderKey = providerKeySchema.parse(
        input.expectedProviderKey,
      );
      const workerId = identifierSchema.parse(input.workerId);
      const purpose = z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-z][a-z0-9._:-]{0,127}$/u)
        .parse(input.purpose);
      const traceId = safeOptionalIdentifier(input.traceId);
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        undefined,
        async (client, workspaceId) => {
          const result = await client.query<Record<string, unknown>>(
            `select connection.*,
                    secret.id as secret_id,
                    secret.schema_version,
                    secret.kms_key_reference,
                    secret.encrypted_data_key,
                    secret.ciphertext,
                    secret.nonce,
                    secret.auth_tag
             from app.connections connection
             join app.connection_secret_versions secret
               on secret.workspace_id = connection.workspace_id
              and secret.connection_id = connection.id
              and secret.id = connection.current_secret_version_id
             join app.workspaces workspace on workspace.id = connection.workspace_id
             where connection.workspace_id = $1 and connection.id = $2
               and connection.provider_key = $3
               and connection.status = 'active'
               and workspace.status = 'active'
             for share of connection`,
            [workspaceId, connectionId, expectedProviderKey],
          );
          const row = result.rows[0];
          if (row === undefined)
            throw new ConnectionUnavailableError(
              'Connection is not available for credential use',
            );
          const connection = mapConnection(row);
          const secretVersionId = uuidSchema.parse(row.secret_id);
          if (secretVersionId !== connection.currentSecretVersionId)
            throw new Error('Connection secret pointer is corrupt');
          await client.query(
            `insert into app.connection_events
               (id, workspace_id, connection_id, event_type, actor_kind,
                actor_id, trace_id, metadata)
             values ($1, $2, $3, 'connection.credential_accessed', 'worker',
                     $4, $5, $6::jsonb)`,
            [
              randomUUID(),
              workspaceId,
              connectionId,
              workerId,
              traceId,
              JSON.stringify({ purpose, secretVersionId }),
            ],
          );
          return Object.freeze({
            connection,
            secretVersionId,
            sealed: mapSealed(row),
          });
        },
      );
    },

    recordConnectionHealth: async (input): Promise<ConnectionRecord> => {
      const connectionId = uuidSchema.parse(input.connectionId);
      const actorId = identifierSchema.parse(input.actorId);
      const actorKind = z
        .enum(['user', 'worker', 'system'])
        .parse(input.actorKind);
      const metadata = parseRequestMetadata(input);
      const result = input.result.ok
        ? input.result
        : Object.freeze({
            ...input.result,
            errorCode: errorCodeSchema.parse(input.result.errorCode),
          });
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          const connection = await selectConnection(
            client,
            workspaceId,
            connectionId,
            true,
          );
          if (connection === null)
            throw new ConnectionNotFoundError('Connection is not visible');
          if (connection.status === CONNECTION_STATUS.revoked)
            throw new ConnectionUnavailableError('Connection is revoked');
          const status =
            !result.ok && result.reauthorizationRequired === true
              ? CONNECTION_STATUS.reauthorizationRequired
              : connection.status;
          const updated = await client.query<Record<string, unknown>>(
            `update app.connections
             set status = $1,
                 last_tested_at = transaction_timestamp(),
                 last_healthy_at = case when $2 then transaction_timestamp()
                                        else last_healthy_at end,
                 last_error_code = $3,
                 updated_at = transaction_timestamp()
             where workspace_id = $4 and id = $5 returning *`,
            [
              status,
              result.ok,
              result.ok ? null : result.errorCode,
              workspaceId,
              connectionId,
            ],
          );
          const eventType = result.ok
            ? CONNECTION_EVENT_TYPE.testSucceeded
            : result.reauthorizationRequired === true
              ? CONNECTION_EVENT_TYPE.reauthorizationRequired
              : CONNECTION_EVENT_TYPE.testFailed;
          await client.query(
            `insert into app.connection_events
               (id, workspace_id, connection_id, event_type, actor_kind,
                actor_id, request_id, trace_id, metadata)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
            [
              randomUUID(),
              workspaceId,
              connectionId,
              eventType,
              actorKind,
              actorId,
              metadata.requestId,
              metadata.traceId,
              JSON.stringify(result.ok ? {} : { errorCode: result.errorCode }),
            ],
          );
          const row = updated.rows[0];
          if (row === undefined)
            throw new Error('Connection health update returned no row');
          return mapConnection(row);
        },
      );
    },

    startConnectionTest: async (input): Promise<StartConnectionTestResult> => {
      const actorId = uuidSchema.parse(input.actorId);
      const connectionId = uuidSchema.parse(input.connectionId);
      const expectedProviderKey = providerKeySchema.parse(
        input.expectedProviderKey,
      );
      const requestHash = digestSchema.parse(input.requestHash);
      const digest = keyDigest(input.idempotencyKey);
      const dispatchToken = uuidSchema.parse(input.dispatchToken);
      const scope = connectionTestScope(actorId, connectionId);
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          await requireConnectionUser(client, workspaceId, actorId);
          const inserted = await client.query(
            `insert into app.idempotency_records
               (id, workspace_id, operation, scope, key_hash, request_hash,
                status, resource_id, result_ref)
             values ($1, $2, 'connection.test', $3, $4, $5, 'in_progress',
                     $6, $7::jsonb)
             on conflict (workspace_id, operation, scope, key_hash) do nothing
             returning id`,
            [
              randomUUID(),
              workspaceId,
              scope,
              digest,
              requestHash,
              connectionId,
              JSON.stringify(connectionTestClaim(dispatchToken, 'claimed')),
            ],
          );
          const claim = await client.query<{
            request_hash: string;
            result_ref: unknown;
            stale: boolean;
            status: string;
          }>(
            `select request_hash, status, result_ref,
                    updated_at < transaction_timestamp() - interval '2 minutes'
                      as stale
             from app.idempotency_records
             where workspace_id = $1 and operation = 'connection.test'
               and scope = $2 and key_hash = $3 for update`,
            [workspaceId, scope, digest],
          );
          const current = claim.rows[0];
          if (current === undefined)
            throw new Error('Connection test idempotency claim is unavailable');
          if (current.request_hash !== requestHash)
            throw new ConnectionIdempotencyConflictError(
              'Idempotency key request mismatch',
            );
          if (current.status === 'completed')
            return Object.freeze({
              kind: 'replay' as const,
              result: parseConnectionTestResult(current.result_ref),
            });
          const ownsClaim = inserted.rowCount === 1;
          if (!ownsClaim) {
            if (current.status !== 'failed' && !current.stale)
              throw new ConnectionTestInProgressError(
                'Connection test is already in progress',
              );
            await client.query(
              `update app.idempotency_records
               set status = 'in_progress', result_ref = $1::jsonb,
                   updated_at = transaction_timestamp()
               where workspace_id = $2 and operation = 'connection.test'
                 and scope = $3 and key_hash = $4`,
              [
                JSON.stringify(connectionTestClaim(dispatchToken, 'claimed')),
                workspaceId,
                scope,
                digest,
              ],
            );
          }

          const connection = await selectConnection(
            client,
            workspaceId,
            connectionId,
          );
          if (
            connection?.providerKey !== expectedProviderKey ||
            connection.status !== CONNECTION_STATUS.active
          )
            throw new ConnectionUnavailableError(
              'Connection is not available for testing',
            );
          return Object.freeze({
            kind: 'dispatch' as const,
            dispatchToken,
          });
        },
      );
    },

    resolveConnectionTestSecret: async (
      input,
    ): Promise<ResolvedConnectionSecretRecord> => {
      const actorId = uuidSchema.parse(input.actorId);
      const connectionId = uuidSchema.parse(input.connectionId);
      const expectedProviderKey = providerKeySchema.parse(
        input.expectedProviderKey,
      );
      const requestHash = digestSchema.parse(input.requestHash);
      const dispatchToken = uuidSchema.parse(input.dispatchToken);
      const digest = keyDigest(input.idempotencyKey);
      const scope = connectionTestScope(actorId, connectionId);
      const metadata = parseRequestMetadata(input);
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          await requireConnectionUser(client, workspaceId, actorId);
          const claim = await client.query(
            `select 1 from app.idempotency_records
             where workspace_id = $1 and operation = 'connection.test'
               and scope = $2 and key_hash = $3 and request_hash = $4
               and status = 'in_progress'
               and result_ref->>'dispatchToken' = $5 for share`,
            [workspaceId, scope, digest, requestHash, dispatchToken],
          );
          if (claim.rowCount !== 1)
            throw new ConnectionTestInProgressError(
              'Connection test credential ownership was lost',
            );
          const resolved = await client.query<Record<string, unknown>>(
            `select connection.*,
                    secret.id as secret_id,
                    secret.schema_version,
                    secret.kms_key_reference,
                    secret.encrypted_data_key,
                    secret.ciphertext,
                    secret.nonce,
                    secret.auth_tag
             from app.connections connection
             join app.connection_secret_versions secret
               on secret.workspace_id = connection.workspace_id
              and secret.connection_id = connection.id
              and secret.id = connection.current_secret_version_id
             where connection.workspace_id = $1 and connection.id = $2
               and connection.provider_key = $3
               and connection.status = 'active'
             for share of connection`,
            [workspaceId, connectionId, expectedProviderKey],
          );
          const row = resolved.rows[0];
          if (row === undefined)
            throw new ConnectionUnavailableError(
              'Connection is not available for testing',
            );
          const connection = mapConnection(row);
          const secretVersionId = uuidSchema.parse(row.secret_id);
          if (secretVersionId !== connection.currentSecretVersionId)
            throw new Error('Connection secret pointer is corrupt');
          await client.query(
            `insert into app.connection_events
               (id, workspace_id, connection_id, event_type, actor_kind,
                actor_id, request_id, trace_id, metadata)
             values ($1, $2, $3, 'connection.credential_accessed', 'user',
                     $4, $5, $6, $7::jsonb)`,
            [
              randomUUID(),
              workspaceId,
              connectionId,
              actorId,
              metadata.requestId,
              metadata.traceId,
              JSON.stringify({
                purpose: 'connection.test',
                secretVersionId,
              }),
            ],
          );
          return Object.freeze({
            connection,
            secretVersionId,
            sealed: mapSealed(row),
          });
        },
      );
    },

    markConnectionTestDispatched: async (input): Promise<void> => {
      const actorId = uuidSchema.parse(input.actorId);
      const connectionId = uuidSchema.parse(input.connectionId);
      const secretVersionId = uuidSchema.parse(input.secretVersionId);
      const requestHash = digestSchema.parse(input.requestHash);
      const dispatchToken = uuidSchema.parse(input.dispatchToken);
      const digest = keyDigest(input.idempotencyKey);
      const scope = connectionTestScope(actorId, connectionId);
      const metadata = parseRequestMetadata(input);
      await withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          await requireConnectionUser(client, workspaceId, actorId);
          const connection = await selectConnection(
            client,
            workspaceId,
            connectionId,
          );
          if (
            connection?.status !== CONNECTION_STATUS.active ||
            connection.currentSecretVersionId !== secretVersionId
          )
            throw new ConnectionUnavailableError(
              'Connection changed before test dispatch',
            );
          const marked = await client.query(
            `update app.idempotency_records
             set result_ref = $1::jsonb, updated_at = transaction_timestamp()
             where workspace_id = $2 and operation = 'connection.test'
               and scope = $3 and key_hash = $4 and request_hash = $5
               and status = 'in_progress'
               and result_ref->>'dispatchToken' = $6`,
            [
              JSON.stringify(connectionTestClaim(dispatchToken, 'dispatched')),
              workspaceId,
              scope,
              digest,
              requestHash,
              dispatchToken,
            ],
          );
          if (marked.rowCount !== 1)
            throw new ConnectionTestInProgressError(
              'Connection test dispatch ownership was lost',
            );
          await client.query(
            `insert into app.audit_events
               (id, workspace_id, actor_user_id, action, target_type,
                target_id, request_id, trace_id, metadata)
             values ($1, $2, $3, 'connection.test_dispatched', 'connection',
                     $4, $5, $6, $7::jsonb)`,
            [
              randomUUID(),
              workspaceId,
              actorId,
              connectionId,
              metadata.requestId,
              metadata.traceId,
              JSON.stringify({ secretVersionId }),
            ],
          );
        },
      );
    },

    completeConnectionTest: async (input): Promise<ConnectionTestResult> => {
      const actorId = uuidSchema.parse(input.actorId);
      const connectionId = uuidSchema.parse(input.connectionId);
      const requestHash = digestSchema.parse(input.requestHash);
      const dispatchToken = uuidSchema.parse(input.dispatchToken);
      const secretVersionId = uuidSchema.parse(input.secretVersionId);
      const digest = keyDigest(input.idempotencyKey);
      const scope = connectionTestScope(actorId, connectionId);
      const metadata = parseRequestMetadata(input);
      const outcome = connectionTestOutcomeSchema.parse(input.outcome);
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          const claim = await client.query<{ result_ref: unknown }>(
            `select result_ref from app.idempotency_records
             where workspace_id = $1 and operation = 'connection.test'
               and scope = $2 and key_hash = $3 and request_hash = $4
               and status = 'in_progress'
               and result_ref->>'dispatchToken' = $5 for update`,
            [workspaceId, scope, digest, requestHash, dispatchToken],
          );
          if (claim.rows[0] === undefined)
            throw new ConnectionTestInProgressError(
              'Connection test completion ownership was lost',
            );
          const claimState = connectionTestClaimSchema.parse(
            claim.rows[0].result_ref,
          );
          if (
            (outcome.ok || outcome.httpStatus !== null) &&
            claimState.state !== 'dispatched'
          )
            throw new ConnectionTestInProgressError(
              'Connection test has no dispatch evidence',
            );
          const current = await selectConnection(
            client,
            workspaceId,
            connectionId,
            true,
          );
          if (current === null)
            throw new ConnectionNotFoundError('Connection is not visible');

          let connection = current;
          const currentSecretWasTested =
            current.currentSecretVersionId === secretVersionId;
          if (
            current.status !== CONNECTION_STATUS.revoked &&
            currentSecretWasTested
          ) {
            const status = outcome.ok
              ? CONNECTION_STATUS.active
              : outcome.reauthorizationRequired
                ? CONNECTION_STATUS.reauthorizationRequired
                : current.status;
            const updated = await client.query<Record<string, unknown>>(
              `update app.connections
               set status = $1,
                   last_tested_at = transaction_timestamp(),
                   last_healthy_at = case when $2 then transaction_timestamp()
                                          else last_healthy_at end,
                   last_error_code = $3,
                   updated_at = transaction_timestamp()
               where workspace_id = $4 and id = $5 returning *`,
              [
                status,
                outcome.ok,
                outcome.ok ? null : outcome.errorCode,
                workspaceId,
                connectionId,
              ],
            );
            const row = updated.rows[0];
            if (row === undefined)
              throw new Error('Connection test health update returned no row');
            connection = mapConnection(row);
          }
          const eventType = outcome.ok
            ? CONNECTION_EVENT_TYPE.testSucceeded
            : outcome.reauthorizationRequired
              ? CONNECTION_EVENT_TYPE.reauthorizationRequired
              : CONNECTION_EVENT_TYPE.testFailed;
          await client.query(
            `insert into app.connection_events
               (id, workspace_id, connection_id, event_type, actor_kind,
                actor_id, request_id, trace_id, metadata)
             values ($1, $2, $3, $4, 'user', $5, $6, $7, $8::jsonb)`,
            [
              randomUUID(),
              workspaceId,
              connectionId,
              eventType,
              actorId,
              metadata.requestId,
              metadata.traceId,
              JSON.stringify(
                outcome.ok
                  ? {
                      httpStatus: outcome.httpStatus,
                      secretVersionId,
                      currentSecretWasTested,
                    }
                  : {
                      errorCode: outcome.errorCode,
                      httpStatus: outcome.httpStatus,
                      secretVersionId,
                      currentSecretWasTested,
                    },
              ),
            ],
          );
          const result = Object.freeze({ connection, outcome });
          await client.query(
            `update app.idempotency_records
             set status = 'completed', result_ref = $1::jsonb,
                 updated_at = transaction_timestamp()
             where workspace_id = $2 and operation = 'connection.test'
               and scope = $3 and key_hash = $4`,
            [
              JSON.stringify(serializeConnectionTestResult(result)),
              workspaceId,
              scope,
              digest,
            ],
          );
          return result;
        },
      );
    },

    abandonConnectionTest: async (input): Promise<void> => {
      const actorId = uuidSchema.parse(input.actorId);
      const connectionId = uuidSchema.parse(input.connectionId);
      const requestHash = digestSchema.parse(input.requestHash);
      const dispatchToken = uuidSchema.parse(input.dispatchToken);
      const digest = keyDigest(input.idempotencyKey);
      const scope = connectionTestScope(actorId, connectionId);
      await withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          await client.query(
            `update app.idempotency_records
             set status = 'failed',
                 result_ref = '{"schemaVersion":1,"state":"failed"}'::jsonb,
                 updated_at = transaction_timestamp()
             where workspace_id = $1 and operation = 'connection.test'
               and scope = $2 and key_hash = $3 and request_hash = $4
               and status = 'in_progress'
               and result_ref->>'dispatchToken' = $5`,
            [workspaceId, scope, digest, requestHash, dispatchToken],
          );
        },
      );
    },

    close: () => pool.end(),
  };
  return Object.freeze(database);
}
