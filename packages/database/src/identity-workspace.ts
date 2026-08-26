import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { DatabaseError, PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from './config.js';
import {
  IDEMPOTENCY_STATUS,
  IdempotencyRecordCorruptError,
  IdempotencyRequestConflictError,
} from './execution-acceptance.js';

const uuidSchema = z.uuid();
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const metadataSchema = z
  .record(z.string(), z.json())
  .refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 8192);
const issuerSchema = z.url().max(2048);
const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u)
  .refine((value) => !value.includes(','));

export const USER_STATUS = {
  active: 'active',
  suspended: 'suspended',
  deleted: 'deleted',
} as const;
export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];

export const WORKSPACE_STATUS = {
  active: 'active',
  suspended: 'suspended',
  pendingDeletion: 'pending_deletion',
  purging: 'purging',
  deleted: 'deleted',
} as const;
export type WorkspaceStatus =
  (typeof WORKSPACE_STATUS)[keyof typeof WORKSPACE_STATUS];

export const MEMBERSHIP_ROLE = {
  owner: 'owner',
  admin: 'admin',
  builder: 'builder',
  operator: 'operator',
  viewer: 'viewer',
} as const;
export type MembershipRole =
  (typeof MEMBERSHIP_ROLE)[keyof typeof MEMBERSHIP_ROLE];

export type IdentityConflictReason = 'identity' | 'workspace_slug';

export class IdentityConflictError extends Error {
  public override readonly name = 'IdentityConflictError';

  public readonly reason: IdentityConflictReason;

  public constructor(
    message: string,
    options: ErrorOptions & Readonly<{ reason?: IdentityConflictReason }> = {},
  ) {
    super(message, options);
    this.reason = options.reason ?? 'identity';
  }
}

export class IdentityNotFoundError extends Error {
  public override readonly name = 'IdentityNotFoundError';
}

export type WorkspaceLifecycleConflictReason =
  'actor_inactive' | 'invalid_state';

export class WorkspaceLifecycleConflictError extends Error {
  public override readonly name = 'WorkspaceLifecycleConflictError';

  public constructor(
    public readonly reason: WorkspaceLifecycleConflictReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type UserRecord = Readonly<{
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
}>;

export type AuthIdentityRecord = Readonly<{
  id: string;
  userId: string;
  issuer: string;
  providerSubject: string;
  profileMetadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}>;

export type SessionRecord = Readonly<{
  id: string;
  userId: string;
  tokenDigest: string;
  expiresAt: Date;
  revokedAt: Date | null;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
}>;

export type WorkspaceRecord = Readonly<{
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  createdBy: string;
  deletionRequestedAt: Date | null;
  deletionRequestedBy: string | null;
  deletionReason: string | null;
  purgeAfter: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type CreateUserInput = Readonly<{
  id?: string;
  email: string;
  displayName: string;
}>;

export type CreateAuthIdentityInput = Readonly<{
  id?: string;
  userId: string;
  issuer: string;
  providerSubject: string;
  profileMetadata?: Record<string, unknown>;
}>;

export type ResolveOrCreateIdentityInput = Readonly<{
  issuer: string;
  providerSubject: string;
  email: string;
  displayName: string;
  profileMetadata?: Record<string, unknown>;
}>;

export type ResolvedIdentity = Readonly<{
  user: UserRecord;
  identity: AuthIdentityRecord;
}>;

export type WorkspaceAccessRecord = Readonly<{
  actorId: string;
  workspaceId: string;
  role: MembershipRole;
  membershipStatus: 'active' | 'suspended' | 'removed';
  workspaceStatus: WorkspaceStatus;
}>;

export type CreateSessionInput = Readonly<{
  id?: string;
  userId: string;
  tokenDigest: string;
  expiresAt: Date;
  userAgent?: string | null;
  ipAddress?: string | null;
}>;

export type WorkspaceWithOwnerInput = Readonly<{
  id?: string;
  name: string;
  slug: string;
  ownerUserId: string;
  requestId?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}>;

export type WorkspaceCommandOptions = Readonly<{
  requestId?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}>;

export type WorkspaceLifecycleResult = Readonly<{
  workspace: WorkspaceRecord;
  revokedSessionCount: number;
}>;

export type IdentityWorkspaceDatabase = Readonly<{
  createUser(input: CreateUserInput): Promise<UserRecord>;
  findUserById(userId: string): Promise<UserRecord | null>;
  linkAuthIdentity(input: CreateAuthIdentityInput): Promise<AuthIdentityRecord>;
  resolveOrCreateIdentity(
    input: ResolveOrCreateIdentityInput,
  ): Promise<ResolvedIdentity>;
  findWorkspaceAccess(
    actorId: string,
    workspaceId: string,
  ): Promise<WorkspaceAccessRecord | null>;
  findAuthIdentity(
    issuer: string,
    providerSubject: string,
  ): Promise<AuthIdentityRecord | null>;
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  findActiveSessionByDigest(tokenDigest: string): Promise<SessionRecord | null>;
  revokeSession(sessionId: string): Promise<boolean>;
  revokeSessionByDigest(tokenDigest: string): Promise<boolean>;
  createWorkspaceWithOwner(
    input: WorkspaceWithOwnerInput,
  ): Promise<WorkspaceRecord>;
  requestWorkspaceDeletion(
    workspaceId: string,
    actorUserId: string,
    purgeAfter: Date | undefined,
    reason: string,
    options?: WorkspaceCommandOptions,
  ): Promise<WorkspaceLifecycleResult>;
  restoreWorkspace(
    workspaceId: string,
    actorUserId: string,
    options?: WorkspaceCommandOptions,
  ): Promise<WorkspaceLifecycleResult>;
  close(): Promise<void>;
}>;

function parseUuid(value: string): string {
  return uuidSchema.parse(value);
}

const unsafeMetadataKey =
  /(?:password|secret|token|credential|verifier|nonce|private[_-]?key|authorization|cookie)/iu;

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
      ) {
        throw new Error('Unsafe audit metadata key');
      }
      assertSafeMetadata(item);
    }
  }
}

function parseMetadata(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const parsed = metadataSchema.parse(value ?? {});
  assertSafeMetadata(parsed);
  return parsed;
}

function databaseConflict(
  error: unknown,
  message: string,
  reason: IdentityConflictReason = 'identity',
): never {
  const code =
    error instanceof Error ? (error as DatabaseError).code : undefined;
  if (code === '23505' || code === '23503' || code === '23514') {
    throw new IdentityConflictError(message, { cause: error, reason });
  }
  throw error;
}

function mapUser(row: Record<string, unknown>): UserRecord {
  return Object.freeze({
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    status: row.status as UserStatus,
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
  });
}

function mapAuthIdentity(row: Record<string, unknown>): AuthIdentityRecord {
  return Object.freeze({
    id: String(row.id),
    userId: String(row.user_id),
    issuer: String(row.issuer),
    providerSubject: String(row.provider_subject),
    profileMetadata: row.profile_metadata as Record<string, unknown>,
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
  });
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string')
    throw new Error('Database returned a non-string value');
  return value;
}

function mapSession(row: Record<string, unknown>): SessionRecord {
  return Object.freeze({
    id: String(row.id),
    userId: String(row.user_id),
    tokenDigest: String(row.token_digest),
    expiresAt: new Date(row.expires_at as string | Date),
    revokedAt:
      row.revoked_at === null
        ? null
        : new Date(row.revoked_at as string | Date),
    userAgent: nullableString(row.user_agent),
    ipAddress: nullableString(row.ip_address),
    createdAt: new Date(row.created_at as string | Date),
  });
}

function mapWorkspace(row: Record<string, unknown>): WorkspaceRecord {
  return Object.freeze({
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    status: row.status as WorkspaceStatus,
    createdBy: String(row.created_by),
    deletionRequestedAt:
      row.deletion_requested_at === null
        ? null
        : new Date(row.deletion_requested_at as string | Date),
    deletionRequestedBy:
      row.deletion_requested_by === null
        ? null
        : nullableString(row.deletion_requested_by),
    deletionReason: nullableString(row.deletion_reason),
    purgeAfter:
      row.purge_after === null
        ? null
        : new Date(row.purge_after as string | Date),
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
  });
}

const durableWorkspaceResultSchema = z
  .object({
    workspace: z
      .object({
        id: z.uuid(),
        name: z.string(),
        slug: z.string(),
        status: z.enum([
          WORKSPACE_STATUS.active,
          WORKSPACE_STATUS.suspended,
          WORKSPACE_STATUS.pendingDeletion,
          WORKSPACE_STATUS.deleted,
        ]),
        createdBy: z.uuid(),
        deletionRequestedAt: z.iso.datetime().nullable(),
        deletionRequestedBy: z.uuid().nullable(),
        deletionReason: z.string().nullable(),
        purgeAfter: z.iso.datetime().nullable(),
        createdAt: z.iso.datetime(),
        updatedAt: z.iso.datetime(),
      })
      .strict(),
    revokedSessionCount: z.number().int().nonnegative(),
  })
  .strict();

function durableWorkspaceResult(
  workspace: WorkspaceRecord,
  revokedSessionCount: number,
): z.output<typeof durableWorkspaceResultSchema> {
  return durableWorkspaceResultSchema.parse({
    workspace: {
      ...workspace,
      deletionRequestedAt: workspace.deletionRequestedAt?.toISOString() ?? null,
      purgeAfter: workspace.purgeAfter?.toISOString() ?? null,
      createdAt: workspace.createdAt.toISOString(),
      updatedAt: workspace.updatedAt.toISOString(),
    },
    revokedSessionCount,
  });
}

function parseDurableWorkspaceResult(value: unknown): WorkspaceLifecycleResult {
  const result = durableWorkspaceResultSchema.safeParse(value);
  if (!result.success) throw new IdempotencyRecordCorruptError();
  const workspace = result.data.workspace;
  return Object.freeze({
    workspace: Object.freeze({
      ...workspace,
      deletionRequestedAt:
        workspace.deletionRequestedAt === null
          ? null
          : new Date(workspace.deletionRequestedAt),
      purgeAfter:
        workspace.purgeAfter === null ? null : new Date(workspace.purgeAfter),
      createdAt: new Date(workspace.createdAt),
      updatedAt: new Date(workspace.updatedAt),
    }),
    revokedSessionCount: result.data.revokedSessionCount,
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function commandRequestHash(value: Record<string, unknown>): string {
  return sha256(canonicalJson(value));
}

function commandKeyHash(value: string | undefined): string {
  return sha256(idempotencyKeySchema.parse(value ?? randomUUID()));
}

type CommandClaim =
  | Readonly<{ claimed: true; id: string }>
  | Readonly<{ claimed: false; result: WorkspaceLifecycleResult }>;

async function claimWorkspaceCreationCommand(
  client: PoolClient,
  actorUserId: string,
  keyHash: string,
  requestHash: string,
): Promise<CommandClaim> {
  const operation = 'workspace.create';
  const inserted = await client.query<{ id: string }>(
    `insert into app.workspace_creation_idempotency_records
       (id, actor_user_id, operation, key_hash, request_hash, status)
     values ($1, $2, $3, $4, $5, 'in_progress')
     on conflict (actor_user_id, operation, key_hash) do nothing
     returning id`,
    [randomUUID(), actorUserId, operation, keyHash, requestHash],
  );
  const insertedId = inserted.rows[0]?.id;
  if (insertedId !== undefined) return { claimed: true, id: insertedId };

  const existing = await client.query<{
    request_hash: string;
    result_ref: unknown;
    status: string;
  }>(
    `select request_hash, status, result_ref
     from app.workspace_creation_idempotency_records
     where actor_user_id = $1 and operation = $2 and key_hash = $3`,
    [actorUserId, operation, keyHash],
  );
  const row = existing.rows[0];
  if (row === undefined) throw new IdempotencyRecordCorruptError();
  if (row.request_hash !== requestHash) {
    throw new IdempotencyRequestConflictError();
  }
  if (row.status !== IDEMPOTENCY_STATUS.completed) {
    throw new IdempotencyRecordCorruptError();
  }
  return {
    claimed: false,
    result: parseDurableWorkspaceResult(row.result_ref),
  };
}

async function completeWorkspaceCreationCommand(
  client: PoolClient,
  claimId: string,
  result: WorkspaceLifecycleResult,
): Promise<void> {
  const completed = await client.query(
    `update app.workspace_creation_idempotency_records
     set status = 'completed', resource_id = $2, result_ref = $3::jsonb,
         updated_at = clock_timestamp()
     where id = $1 and status = 'in_progress'`,
    [
      claimId,
      result.workspace.id,
      JSON.stringify(
        durableWorkspaceResult(result.workspace, result.revokedSessionCount),
      ),
    ],
  );
  if (completed.rowCount !== 1) throw new IdempotencyRecordCorruptError();
}

async function claimWorkspaceLifecycleCommand(
  client: PoolClient,
  workspaceId: string,
  operation: 'workspace.deletion.request' | 'workspace.restore',
  keyHash: string,
  requestHash: string,
): Promise<CommandClaim> {
  const scope = 'workspace.lifecycle';
  const claimId = randomUUID();
  const inserted = await client.query<{ id: string }>(
    `insert into app.idempotency_records
       (id, workspace_id, operation, scope, key_hash, request_hash, status,
        resource_id, result_ref)
     values ($1, $2, $3, $4, $5, $6, 'in_progress', $2, '{}'::jsonb)
     on conflict (workspace_id, operation, scope, key_hash) do nothing
     returning id`,
    [claimId, workspaceId, operation, scope, keyHash, requestHash],
  );
  if (inserted.rowCount === 1) return { claimed: true, id: claimId };

  const existing = await client.query<{
    request_hash: string;
    result_ref: unknown;
    status: string;
  }>(
    `select request_hash, status, result_ref
     from app.idempotency_records
     where workspace_id = $1 and operation = $2 and scope = $3 and key_hash = $4`,
    [workspaceId, operation, scope, keyHash],
  );
  const row = existing.rows[0];
  if (row === undefined) throw new IdempotencyRecordCorruptError();
  if (row.request_hash !== requestHash) {
    throw new IdempotencyRequestConflictError();
  }
  if (row.status !== IDEMPOTENCY_STATUS.completed) {
    throw new IdempotencyRecordCorruptError();
  }
  return {
    claimed: false,
    result: parseDurableWorkspaceResult(row.result_ref),
  };
}

async function completeWorkspaceLifecycleCommand(
  client: PoolClient,
  claimId: string,
  result: WorkspaceLifecycleResult,
): Promise<void> {
  const completed = await client.query(
    `update app.idempotency_records
     set status = 'completed', result_ref = $2::jsonb,
         updated_at = clock_timestamp()
     where id = $1 and status = 'in_progress'`,
    [
      claimId,
      JSON.stringify(
        durableWorkspaceResult(result.workspace, result.revokedSessionCount),
      ),
    ],
  );
  if (completed.rowCount !== 1) throw new IdempotencyRecordCorruptError();
}

async function assertNoPlatformContext(client: PoolClient): Promise<void> {
  const result = await client.query<{
    actor_id: string | null;
    workspace_id: string | null;
  }>(
    `select current_setting('app.workspace_id', true) as workspace_id,
            current_setting('app.actor_id', true) as actor_id`,
  );
  const row = result.rows[0];
  if (
    [row?.workspace_id, row?.actor_id].some(
      (value) => value !== undefined && value !== null && value !== '',
    )
  ) {
    throw new Error('Pooled PostgreSQL client retained platform context');
  }
}

async function withTransaction<T>(
  pool: Pool,
  workspaceId: string | undefined,
  operation: (client: PoolClient) => Promise<T>,
  actorId?: string,
): Promise<T> {
  const client = await pool.connect();
  let open = false;
  let released = false;
  try {
    await assertNoPlatformContext(client);
    await client.query('begin');
    open = true;
    if (workspaceId !== undefined) {
      await client.query("select set_config('app.workspace_id', $1, true)", [
        parseUuid(workspaceId),
      ]);
    }
    if (actorId !== undefined) {
      await client.query("select set_config('app.actor_id', $1, true)", [
        parseUuid(actorId),
      ]);
    }
    const result = await operation(client);
    await client.query('commit');
    open = false;
    await assertNoPlatformContext(client);
    released = true;
    client.release();
    return result;
  } catch (error: unknown) {
    if (open) await client.query('rollback').catch(() => undefined);
    if (!released) {
      try {
        await assertNoPlatformContext(client);
        released = true;
        client.release();
      } catch {
        // A session-level tenant setting is contamination. Remove the client
        // from the pool rather than returning it to another request.
        released = true;
        client.release(true);
      }
    }
    throw error;
  }
}

export function createIdentityWorkspaceDatabase(
  config: DatabaseConfig,
): IdentityWorkspaceDatabase {
  const pool = new Pool(config);

  const database = {
    createUser: async (input: CreateUserInput): Promise<UserRecord> => {
      const id = parseUuid(input.id ?? randomUUID());
      if (input.email.trim() !== input.email || input.email.length < 3) {
        throw new Error('Invalid user email');
      }
      if (input.displayName.trim().length === 0) {
        throw new Error('Invalid user display name');
      }
      try {
        const result = await pool.query(
          `insert into app.users (id, email, display_name, status)
           values ($1, $2, $3, 'active')
           returning id, email, display_name, status, created_at, updated_at`,
          [id, input.email, input.displayName],
        );
        return mapUser(result.rows[0] as Record<string, unknown>);
      } catch (error: unknown) {
        databaseConflict(
          error,
          'User identity conflicts with an existing record',
        );
      }
    },

    findUserById: async (userId: string): Promise<UserRecord | null> => {
      const result = await pool.query(
        `select id, email, display_name, status, created_at, updated_at
         from app.users where id = $1`,
        [parseUuid(userId)],
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row === undefined ? null : mapUser(row);
    },

    linkAuthIdentity: async (
      input: CreateAuthIdentityInput,
    ): Promise<AuthIdentityRecord> => {
      const id = parseUuid(input.id ?? randomUUID());
      const userId = parseUuid(input.userId);
      const issuer = issuerSchema.parse(input.issuer);
      const providerSubject = z
        .string()
        .min(1)
        .max(255)
        .parse(input.providerSubject);
      const profileMetadata = parseMetadata(input.profileMetadata);
      const existing = await pool.query(
        `select id, user_id, issuer, provider_subject, profile_metadata,
                created_at, updated_at
         from app.auth_identities
         where issuer = $1 and provider_subject = $2`,
        [issuer, providerSubject],
      );
      if (existing.rows[0] !== undefined) {
        const row = existing.rows[0] as Record<string, unknown>;
        if (String(row.user_id) !== userId) {
          throw new IdentityConflictError(
            'Authentication identity is linked to another user',
          );
        }
        return mapAuthIdentity(row);
      }
      try {
        const result = await pool.query(
          `insert into app.auth_identities
             (id, user_id, issuer, provider_subject, profile_metadata)
           values ($1, $2, $3, $4, $5::jsonb)
           returning id, user_id, issuer, provider_subject, profile_metadata,
                     created_at, updated_at`,
          [
            id,
            userId,
            issuer,
            providerSubject,
            JSON.stringify(profileMetadata),
          ],
        );
        return mapAuthIdentity(result.rows[0] as Record<string, unknown>);
      } catch (error: unknown) {
        const code =
          error instanceof Error ? (error as DatabaseError).code : undefined;
        if (code === '23505') {
          const raced = await pool.query(
            `select id, user_id, issuer, provider_subject, profile_metadata,
                    created_at, updated_at
             from app.auth_identities
             where issuer = $1 and provider_subject = $2`,
            [issuer, providerSubject],
          );
          const row = raced.rows[0] as Record<string, unknown> | undefined;
          if (row !== undefined && String(row.user_id) === userId) {
            return mapAuthIdentity(row);
          }
        }
        databaseConflict(
          error,
          'Authentication identity conflicts with an existing record',
        );
      }
    },

    findAuthIdentity: async (
      issuerInput: string,
      providerSubjectInput: string,
    ): Promise<AuthIdentityRecord | null> => {
      const result = await pool.query(
        `select id, user_id, issuer, provider_subject, profile_metadata,
                created_at, updated_at
         from app.auth_identities
         where issuer = $1 and provider_subject = $2`,
        [
          issuerSchema.parse(issuerInput),
          z.string().min(1).max(255).parse(providerSubjectInput),
        ],
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row === undefined ? null : mapAuthIdentity(row);
    },

    resolveOrCreateIdentity: async (
      input: ResolveOrCreateIdentityInput,
    ): Promise<ResolvedIdentity> => {
      const issuer = issuerSchema.parse(input.issuer);
      const providerSubject = z
        .string()
        .min(1)
        .max(255)
        .parse(input.providerSubject);
      const email = z.string().trim().min(3).max(320).parse(input.email);
      const displayName = z
        .string()
        .trim()
        .min(1)
        .max(256)
        .parse(input.displayName);
      const profileMetadata = parseMetadata(input.profileMetadata);
      return withTransaction(pool, undefined, async (client) => {
        // Serialize only this issuer/subject pair. This keeps the user insert
        // and identity insert atomic without granting the runtime role delete
        // access for compensating orphan cleanup.
        await client.query(
          'select pg_advisory_xact_lock(hashtextextended($1, 0))',
          [
            createHash('sha256')
              .update(issuer)
              .update('\u0000')
              .update(providerSubject)
              .digest('hex'),
          ],
        );
        const existing = await client.query(
          `select
             u.id as user_id, u.email as user_email, u.display_name as user_display_name,
             u.status as user_status, u.created_at as user_created_at,
             u.updated_at as user_updated_at,
             i.id as identity_id, i.issuer, i.provider_subject, i.profile_metadata,
             i.created_at as identity_created_at, i.updated_at as identity_updated_at
           from app.auth_identities i
           join app.users u on u.id = i.user_id
           where i.issuer = $1 and i.provider_subject = $2`,
          [issuer, providerSubject],
        );
        const existingRow = existing.rows[0] as
          Record<string, unknown> | undefined;
        if (existingRow !== undefined) {
          if (existingRow.user_status !== USER_STATUS.active) {
            throw new IdentityNotFoundError(
              'Authentication identity is not available',
            );
          }
          return {
            user: mapUser({
              id: existingRow.user_id,
              email: existingRow.user_email,
              display_name: existingRow.user_display_name,
              status: existingRow.user_status,
              created_at: existingRow.user_created_at,
              updated_at: existingRow.user_updated_at,
            }),
            identity: mapAuthIdentity({
              id: existingRow.identity_id,
              user_id: existingRow.user_id,
              issuer: existingRow.issuer,
              provider_subject: existingRow.provider_subject,
              profile_metadata: existingRow.profile_metadata,
              created_at: existingRow.identity_created_at,
              updated_at: existingRow.identity_updated_at,
            }),
          };
        }
        const userResult = await client.query(
          `insert into app.users (id, email, display_name, status)
           values ($1, $2, $3, 'active')
           returning id, email, display_name, status, created_at, updated_at`,
          [randomUUID(), email, displayName],
        );
        const user = mapUser(userResult.rows[0] as Record<string, unknown>);
        const identityResult = await client.query(
          `insert into app.auth_identities
             (id, user_id, issuer, provider_subject, profile_metadata)
           values ($1, $2, $3, $4, $5::jsonb)
           returning id, user_id, issuer, provider_subject, profile_metadata,
                     created_at, updated_at`,
          [
            randomUUID(),
            user.id,
            issuer,
            providerSubject,
            JSON.stringify(profileMetadata),
          ],
        );
        return {
          user,
          identity: mapAuthIdentity(
            identityResult.rows[0] as Record<string, unknown>,
          ),
        };
      });
    },

    findWorkspaceAccess: async (
      actorIdInput: string,
      workspaceIdInput: string,
    ): Promise<WorkspaceAccessRecord | null> => {
      const actorId = parseUuid(actorIdInput);
      const workspaceId = parseUuid(workspaceIdInput);
      return withTransaction(pool, workspaceId, async (client) => {
        const result = await client.query<{
          actor_id: string;
          workspace_id: string;
          role: MembershipRole;
          membership_status: 'active' | 'suspended' | 'removed';
          workspace_status: WorkspaceStatus;
        }>(
          `select m.user_id as actor_id, m.workspace_id,
                  m.role, m.status as membership_status,
                  w.status as workspace_status
           from app.workspace_memberships m
           join app.workspaces w on w.id = m.workspace_id
           join app.users u on u.id = m.user_id and u.status = 'active'
           where m.workspace_id = $1 and m.user_id = $2`,
          [workspaceId, actorId],
        );
        const row = result.rows[0];
        return row === undefined
          ? null
          : Object.freeze({
              actorId: row.actor_id,
              workspaceId: row.workspace_id,
              role: row.role,
              membershipStatus: row.membership_status,
              workspaceStatus: row.workspace_status,
            });
      });
    },

    createSession: async (
      input: CreateSessionInput,
    ): Promise<SessionRecord> => {
      const id = parseUuid(input.id ?? randomUUID());
      const tokenDigest = digestSchema.parse(input.tokenDigest);
      if (
        !(input.expiresAt instanceof Date) ||
        input.expiresAt.getTime() <= Date.now()
      ) {
        throw new Error('Session expiry must be in the future');
      }
      try {
        const result = await pool.query(
          `insert into app.sessions
             (id, user_id, token_digest, expires_at, user_agent, ip_address)
           select $1, u.id, $3, $4, $5, $6
           from app.users u
           where u.id = $2 and u.status = 'active'
           returning id, user_id, token_digest, expires_at, revoked_at,
                     user_agent, ip_address, created_at`,
          [
            id,
            parseUuid(input.userId),
            tokenDigest,
            input.expiresAt,
            input.userAgent ?? null,
            input.ipAddress ?? null,
          ],
        );
        const row = result.rows[0] as Record<string, unknown> | undefined;
        if (row === undefined) {
          throw new IdentityNotFoundError('User is not available');
        }
        return mapSession(row);
      } catch (error: unknown) {
        databaseConflict(
          error,
          'Session conflicts with an existing identity record',
        );
      }
    },

    findActiveSessionByDigest: async (
      tokenDigestInput: string,
    ): Promise<SessionRecord | null> => {
      const result = await pool.query(
        `select s.id, s.user_id, s.token_digest, s.expires_at, s.revoked_at,
                s.user_agent, s.ip_address, s.created_at
         from app.sessions s
         join app.users u on u.id = s.user_id and u.status = 'active'
         where s.token_digest = $1 and s.revoked_at is null
           and s.expires_at > clock_timestamp()`,
        [digestSchema.parse(tokenDigestInput)],
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row === undefined ? null : mapSession(row);
    },

    revokeSession: async (sessionIdInput: string): Promise<boolean> => {
      const result = await pool.query(
        `update app.sessions
         set revoked_at = coalesce(revoked_at, clock_timestamp())
         where id = $1 and revoked_at is null`,
        [parseUuid(sessionIdInput)],
      );
      return result.rowCount === 1;
    },

    revokeSessionByDigest: async (
      tokenDigestInput: string,
    ): Promise<boolean> => {
      const result = await pool.query(
        `update app.sessions
         set revoked_at = clock_timestamp()
         where token_digest = $1 and revoked_at is null`,
        [digestSchema.parse(tokenDigestInput)],
      );
      return result.rowCount === 1;
    },

    createWorkspaceWithOwner: async (
      input: WorkspaceWithOwnerInput,
    ): Promise<WorkspaceRecord> => {
      const id = parseUuid(input.id ?? randomUUID());
      const ownerUserId = parseUuid(input.ownerUserId);
      const metadata = parseMetadata(input.metadata);
      const name = input.name.trim();
      const slug = input.slug.trim().toLowerCase();
      if (name.length === 0 || name.length > 128)
        throw new Error('Invalid workspace name');
      if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)) {
        throw new Error('Invalid workspace slug');
      }
      const keyHash = commandKeyHash(input.idempotencyKey);
      const requestHash = commandRequestHash({
        actorId: ownerUserId,
        metadata,
        name,
        requestedWorkspaceId: input.id ?? null,
        slug,
      });
      try {
        return await withTransaction(
          pool,
          id,
          async (client) => {
            const claim = await claimWorkspaceCreationCommand(
              client,
              ownerUserId,
              keyHash,
              requestHash,
            );
            if (!claim.claimed) return claim.result.workspace;

            const workspaceResult = await client.query(
              `insert into app.workspaces (id, name, slug, status, created_by)
             values ($1, $2, $3, 'active', $4)
             returning id, name, slug, status, created_by,
                       deletion_requested_at, deletion_requested_by, deletion_reason,
                       purge_after,
                       created_at, updated_at`,
              [id, name, slug, ownerUserId],
            );
            await client.query(
              `insert into app.workspace_memberships
               (workspace_id, user_id, role, status)
             values ($1, $2, 'owner', 'active')`,
              [id, ownerUserId],
            );
            await client.query(
              `insert into app.audit_events
               (id, workspace_id, actor_user_id, action, target_type, target_id,
                request_id, trace_id, metadata)
             values ($1, $2, $3, 'workspace.created', 'workspace', $2, $4, $5, $6::jsonb)`,
              [
                randomUUID(),
                id,
                ownerUserId,
                input.requestId ?? null,
                input.traceId ?? null,
                JSON.stringify(metadata),
              ],
            );
            const workspace = mapWorkspace(
              workspaceResult.rows[0] as Record<string, unknown>,
            );
            await completeWorkspaceCreationCommand(client, claim.id, {
              workspace,
              revokedSessionCount: 0,
            });
            return workspace;
          },
          ownerUserId,
        );
      } catch (error: unknown) {
        databaseConflict(
          error,
          'Workspace creation conflicts with an existing record',
          'workspace_slug',
        );
      }
    },

    requestWorkspaceDeletion: async (
      workspaceIdInput: string,
      actorUserIdInput: string,
      purgeAfter: Date | undefined,
      reason: string,
      options = {},
    ): Promise<WorkspaceLifecycleResult> => {
      const workspaceId = parseUuid(workspaceIdInput);
      const actorUserId = parseUuid(actorUserIdInput);
      if (
        purgeAfter !== undefined &&
        (!(purgeAfter instanceof Date) ||
          !Number.isFinite(purgeAfter.getTime()) ||
          purgeAfter.getTime() <= Date.now())
      ) {
        throw new Error('Workspace purge deadline must be in the future');
      }
      const purgeDeadline =
        purgeAfter ?? new Date(Date.now() + 30 * 24 * 60 * 60_000);
      const deletionReason = z.string().trim().min(1).max(512).parse(reason);
      const metadata = parseMetadata(options.metadata);
      const keyHash = commandKeyHash(options.idempotencyKey);
      const requestHash = commandRequestHash({
        actorId: actorUserId,
        metadata,
        purgeAfter: purgeAfter?.toISOString() ?? null,
        reason: deletionReason,
        workspaceId,
      });
      return withTransaction(pool, workspaceId, async (client) => {
        const actor = await client.query(
          `select 1 from app.workspace_memberships
           where workspace_id = $1 and user_id = $2 and status = 'active'`,
          [workspaceId, actorUserId],
        );
        if (actor.rowCount !== 1) {
          throw new WorkspaceLifecycleConflictError(
            'actor_inactive',
            'Workspace actor is not an active member',
          );
        }
        const claim = await claimWorkspaceLifecycleCommand(
          client,
          workspaceId,
          'workspace.deletion.request',
          keyHash,
          requestHash,
        );
        if (!claim.claimed) return claim.result;

        const revocable = await client.query<{ count: string }>(
          `select count(*)::text as count from app.sessions s
           where s.revoked_at is null
             and exists (
               select 1 from app.workspace_memberships m
               where m.workspace_id = $1 and m.user_id = s.user_id
                 and m.status <> 'removed'
             )`,
          [workspaceId],
        );
        const result = await client.query(
          `update app.workspaces
           set status = 'pending_deletion', deletion_requested_at = clock_timestamp(),
               deletion_requested_by = $2, deletion_reason = $3,
               purge_after = $4, updated_at = clock_timestamp()
           where id = $1 and status in ('active', 'suspended')
           returning id, name, slug, status, created_by,
                     deletion_requested_at, deletion_requested_by, deletion_reason,
                     purge_after,
                     created_at, updated_at`,
          [workspaceId, actorUserId, deletionReason, purgeDeadline],
        );
        if (result.rowCount !== 1) {
          throw new WorkspaceLifecycleConflictError(
            'invalid_state',
            'Workspace is neither active nor suspended',
          );
        }
        await client.query(
          `insert into app.audit_events
             (id, workspace_id, actor_user_id, action, target_type, target_id,
              request_id, trace_id, metadata)
           values ($1, $2, $3, 'workspace.deletion_requested', 'workspace', $2, $4, $5, $6::jsonb)`,
          [
            randomUUID(),
            workspaceId,
            actorUserId,
            options.requestId ?? null,
            options.traceId ?? null,
            JSON.stringify(metadata),
          ],
        );
        const commandResult = {
          workspace: mapWorkspace(result.rows[0] as Record<string, unknown>),
          revokedSessionCount: Number(revocable.rows[0]?.count ?? 0),
        };
        await completeWorkspaceLifecycleCommand(
          client,
          claim.id,
          commandResult,
        );
        return commandResult;
      });
    },

    restoreWorkspace: async (
      workspaceIdInput: string,
      actorUserIdInput: string,
      options = {},
    ): Promise<WorkspaceLifecycleResult> => {
      const workspaceId = parseUuid(workspaceIdInput);
      const actorUserId = parseUuid(actorUserIdInput);
      const metadata = parseMetadata(options.metadata);
      const keyHash = commandKeyHash(options.idempotencyKey);
      const requestHash = commandRequestHash({
        actorId: actorUserId,
        metadata,
        workspaceId,
      });
      return withTransaction(pool, workspaceId, async (client) => {
        const actor = await client.query(
          `select 1 from app.workspace_memberships
           where workspace_id = $1 and user_id = $2 and status = 'active'`,
          [workspaceId, actorUserId],
        );
        if (actor.rowCount !== 1) {
          throw new WorkspaceLifecycleConflictError(
            'actor_inactive',
            'Workspace actor is not an active member',
          );
        }
        const claim = await claimWorkspaceLifecycleCommand(
          client,
          workspaceId,
          'workspace.restore',
          keyHash,
          requestHash,
        );
        if (!claim.claimed) return claim.result;

        const result = await client.query(
          `update app.workspaces
           set status = 'suspended', deletion_requested_at = null,
               deletion_requested_by = null, deletion_reason = null, purge_after = null,
               updated_at = clock_timestamp()
           where id = $1
             and status = 'pending_deletion'
             and purge_after > clock_timestamp()
           returning id, name, slug, status, created_by,
                     deletion_requested_at, deletion_requested_by, deletion_reason,
                     purge_after,
                     created_at, updated_at`,
          [workspaceId],
        );
        if (result.rowCount !== 1) {
          throw new WorkspaceLifecycleConflictError(
            'invalid_state',
            'Workspace is not restorable',
          );
        }
        await client.query(
          `insert into app.audit_events
             (id, workspace_id, actor_user_id, action, target_type, target_id,
              request_id, trace_id, metadata)
           values ($1, $2, $3, 'workspace.restored', 'workspace', $2, $4, $5, $6::jsonb)`,
          [
            randomUUID(),
            workspaceId,
            actorUserId,
            options.requestId ?? null,
            options.traceId ?? null,
            JSON.stringify(metadata),
          ],
        );
        const commandResult = {
          workspace: mapWorkspace(result.rows[0] as Record<string, unknown>),
          revokedSessionCount: 0,
        };
        await completeWorkspaceLifecycleCommand(
          client,
          claim.id,
          commandResult,
        );
        return commandResult;
      });
    },

    close: async (): Promise<void> => pool.end(),
  } satisfies IdentityWorkspaceDatabase;

  return Object.freeze(database);
}
