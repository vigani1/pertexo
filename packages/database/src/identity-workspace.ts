import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { DatabaseError, PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from './config.js';

const uuidSchema = z.uuid();
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const metadataSchema = z
  .record(z.string(), z.json())
  .refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 8192);
const issuerSchema = z.url().max(2048);

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

export class IdentityConflictError extends Error {
  public override readonly name = 'IdentityConflictError';
}

export class IdentityNotFoundError extends Error {
  public override readonly name = 'IdentityNotFoundError';
}

export class WorkspaceLifecycleConflictError extends Error {
  public override readonly name = 'WorkspaceLifecycleConflictError';
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
  createWorkspaceWithOwner(
    input: WorkspaceWithOwnerInput,
  ): Promise<WorkspaceRecord>;
  requestWorkspaceDeletion(
    workspaceId: string,
    actorUserId: string,
    purgeAfter: Date,
    reason: string,
    options?: Readonly<{
      requestId?: string;
      traceId?: string;
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<WorkspaceLifecycleResult>;
  restoreWorkspace(
    workspaceId: string,
    actorUserId: string,
    options?: Readonly<{
      requestId?: string;
      traceId?: string;
      metadata?: Record<string, unknown>;
    }>,
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

function databaseConflict(error: unknown, message: string): never {
  const code =
    error instanceof Error ? (error as DatabaseError).code : undefined;
  if (code === '23505' || code === '23503' || code === '23514') {
    throw new IdentityConflictError(message, { cause: error });
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

async function assertNoPlatformContext(client: PoolClient): Promise<void> {
  const result = await client.query<{ workspace_id: string | null }>(
    "select current_setting('app.workspace_id', true) as workspace_id",
  );
  const value = result.rows[0]?.workspace_id;
  if (value !== undefined && value !== null && value !== '') {
    throw new Error('Pooled PostgreSQL client retained workspace context');
  }
}

async function withTransaction<T>(
  pool: Pool,
  workspaceId: string | undefined,
  operation: (client: PoolClient) => Promise<T>,
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
           values ($1, $2, $3, $4, $5, $6)
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
        return mapSession(result.rows[0] as Record<string, unknown>);
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
        `select id, user_id, token_digest, expires_at, revoked_at,
                user_agent, ip_address, created_at
         from app.sessions
         where token_digest = $1 and revoked_at is null
           and expires_at > clock_timestamp()`,
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
      try {
        return await withTransaction(pool, id, async (client) => {
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
          return mapWorkspace(
            workspaceResult.rows[0] as Record<string, unknown>,
          );
        });
      } catch (error: unknown) {
        databaseConflict(
          error,
          'Workspace creation conflicts with an existing record',
        );
      }
    },

    requestWorkspaceDeletion: async (
      workspaceIdInput: string,
      actorUserIdInput: string,
      purgeAfter: Date,
      reason: string,
      options = {},
    ): Promise<WorkspaceLifecycleResult> => {
      const workspaceId = parseUuid(workspaceIdInput);
      const actorUserId = parseUuid(actorUserIdInput);
      if (!(purgeAfter instanceof Date) || purgeAfter.getTime() <= Date.now()) {
        throw new Error('Workspace purge deadline must be in the future');
      }
      const deletionReason = z.string().trim().min(1).max(512).parse(reason);
      return withTransaction(pool, workspaceId, async (client) => {
        const actor = await client.query(
          `select 1 from app.workspace_memberships
           where workspace_id = $1 and user_id = $2 and status = 'active'`,
          [workspaceId, actorUserId],
        );
        if (actor.rowCount !== 1) {
          throw new WorkspaceLifecycleConflictError(
            'Workspace actor is not an active member',
          );
        }
        const result = await client.query(
          `update app.workspaces
           set status = 'pending_deletion', deletion_requested_at = clock_timestamp(),
               deletion_requested_by = $2, deletion_reason = $3,
               purge_after = $4, updated_at = clock_timestamp()
           where id = $1 and status = 'active'
           returning id, name, slug, status, created_by,
                     deletion_requested_at, deletion_requested_by, deletion_reason,
                     purge_after,
                     created_at, updated_at`,
          [workspaceId, actorUserId, deletionReason, purgeAfter],
        );
        if (result.rowCount !== 1) {
          throw new WorkspaceLifecycleConflictError('Workspace is not active');
        }
        const revoked = await client.query(
          `update app.sessions s
           set revoked_at = coalesce(s.revoked_at, clock_timestamp())
           where s.revoked_at is null
             and exists (
               select 1 from app.workspace_memberships m
               where m.workspace_id = $1 and m.user_id = s.user_id
                 and m.status <> 'removed'
             )`,
          [workspaceId],
        );
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
            JSON.stringify(parseMetadata(options.metadata)),
          ],
        );
        return {
          workspace: mapWorkspace(result.rows[0] as Record<string, unknown>),
          revokedSessionCount: revoked.rowCount ?? 0,
        };
      });
    },

    restoreWorkspace: async (
      workspaceIdInput: string,
      actorUserIdInput: string,
      options = {},
    ): Promise<WorkspaceLifecycleResult> => {
      const workspaceId = parseUuid(workspaceIdInput);
      const actorUserId = parseUuid(actorUserIdInput);
      return withTransaction(pool, workspaceId, async (client) => {
        const actor = await client.query(
          `select 1 from app.workspace_memberships
           where workspace_id = $1 and user_id = $2 and status = 'active'`,
          [workspaceId, actorUserId],
        );
        if (actor.rowCount !== 1) {
          throw new WorkspaceLifecycleConflictError(
            'Workspace actor is not an active member',
          );
        }
        const result = await client.query(
          `update app.workspaces
           set status = 'suspended', deletion_requested_at = null,
               deletion_requested_by = null, deletion_reason = null, purge_after = null,
               updated_at = clock_timestamp()
           where id = $1 and status = 'pending_deletion'
           returning id, name, slug, status, created_by,
                     deletion_requested_at, deletion_requested_by, deletion_reason,
                     purge_after,
                     created_at, updated_at`,
          [workspaceId],
        );
        if (result.rowCount !== 1) {
          throw new WorkspaceLifecycleConflictError(
            'Workspace is not pending deletion',
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
            JSON.stringify(parseMetadata(options.metadata)),
          ],
        );
        return {
          workspace: mapWorkspace(result.rows[0] as Record<string, unknown>),
          revokedSessionCount: 0,
        };
      });
    },

    close: async (): Promise<void> => pool.end(),
  } satisfies IdentityWorkspaceDatabase;

  return Object.freeze(database);
}
