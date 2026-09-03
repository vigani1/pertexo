import { createHash } from 'node:crypto';

import { generatePersistedId } from './persisted-id.js';

import type { DatabaseError, Pool } from 'pg';
import { z } from 'zod';

import {
  IdentityConflictError,
  IdentityNotFoundError,
} from './identity-workspace-errors.js';
import { mapAuthIdentity, mapUser } from './identity-workspace-rows.js';
import {
  parseIdentityMetadata,
  parseIdentityUuid,
  throwIdentityDatabaseConflict,
} from './identity-workspace-support.js';
import type {
  AuthIdentityRecord,
  CreateAuthIdentityInput,
  CreateUserInput,
  IdentityWorkspaceDatabase,
  ResolveOrCreateIdentityInput,
  ResolvedIdentity,
  UserRecord,
} from './identity-workspace.js';
import { withPlatformTransaction } from './workspace.js';

const issuerSchema = z.url().max(2048);

type IdentityStore = Pick<
  IdentityWorkspaceDatabase,
  | 'createUser'
  | 'findAuthIdentity'
  | 'findUserById'
  | 'linkAuthIdentity'
  | 'resolveOrCreateIdentity'
>;

async function createUser(
  pool: Pool,
  input: CreateUserInput,
): Promise<UserRecord> {
  const id = parseIdentityUuid(input.id ?? generatePersistedId());
  if (input.email.trim() !== input.email || input.email.length < 3)
    throw new Error('Invalid user email');
  if (input.displayName.trim().length === 0)
    throw new Error('Invalid user display name');
  try {
    const result = await pool.query(
      `insert into app.users (id, email, display_name, status)
       values ($1, $2, $3, 'active')
       returning id, email, display_name, status, created_at, updated_at`,
      [id, input.email, input.displayName],
    );
    return mapUser(result.rows[0] as Record<string, unknown>);
  } catch (error: unknown) {
    throwIdentityDatabaseConflict(
      error,
      'User identity conflicts with an existing record',
    );
  }
}

async function findUserById(
  pool: Pool,
  userId: string,
): Promise<UserRecord | null> {
  const result = await pool.query(
    `select id, email, display_name, status, created_at, updated_at
     from app.users where id = $1`,
    [parseIdentityUuid(userId)],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row === undefined ? null : mapUser(row);
}

export function createIdentityWorkspaceIdentityStore(
  pool: Pool,
): IdentityStore {
  return Object.freeze({
    createUser: (input: CreateUserInput) => createUser(pool, input),
    findUserById: (userId: string) => findUserById(pool, userId),
    linkAuthIdentity: async (
      input: CreateAuthIdentityInput,
    ): Promise<AuthIdentityRecord> => {
      const id = parseIdentityUuid(input.id ?? generatePersistedId());
      const userId = parseIdentityUuid(input.userId);
      const issuer = issuerSchema.parse(input.issuer);
      const providerSubject = z
        .string()
        .min(1)
        .max(255)
        .parse(input.providerSubject);
      const profileMetadata = parseIdentityMetadata(input.profileMetadata);
      const existing = await pool.query(
        `select id, user_id, issuer, provider_subject, profile_metadata,
                created_at, updated_at
         from app.auth_identities
         where issuer = $1 and provider_subject = $2`,
        [issuer, providerSubject],
      );
      if (existing.rows[0] !== undefined) {
        const row = existing.rows[0] as Record<string, unknown>;
        if (z.uuid().parse(row.user_id) !== userId)
          throw new IdentityConflictError(
            'Authentication identity is linked to another user',
          );
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
          if (row !== undefined && z.uuid().parse(row.user_id) === userId)
            return mapAuthIdentity(row);
        }
        throwIdentityDatabaseConflict(
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
      const profileMetadata = parseIdentityMetadata(input.profileMetadata);
      return withPlatformTransaction(pool, async (client) => {
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
        const row = existing.rows[0] as Record<string, unknown> | undefined;
        if (row !== undefined) {
          if (row.user_status !== 'active')
            throw new IdentityNotFoundError(
              'Authentication identity is not available',
            );
          return {
            user: mapUser({
              id: row.user_id,
              email: row.user_email,
              display_name: row.user_display_name,
              status: row.user_status,
              created_at: row.user_created_at,
              updated_at: row.user_updated_at,
            }),
            identity: mapAuthIdentity({
              id: row.identity_id,
              user_id: row.user_id,
              issuer: row.issuer,
              provider_subject: row.provider_subject,
              profile_metadata: row.profile_metadata,
              created_at: row.identity_created_at,
              updated_at: row.identity_updated_at,
            }),
          };
        }
        const userResult = await client.query(
          `insert into app.users (id, email, display_name, status)
           values ($1, $2, $3, 'active')
           returning id, email, display_name, status, created_at, updated_at`,
          [generatePersistedId(), email, displayName],
        );
        const user = mapUser(userResult.rows[0] as Record<string, unknown>);
        const identityResult = await client.query(
          `insert into app.auth_identities
             (id, user_id, issuer, provider_subject, profile_metadata)
           values ($1, $2, $3, $4, $5::jsonb)
           returning id, user_id, issuer, provider_subject, profile_metadata,
                     created_at, updated_at`,
          [
            generatePersistedId(),
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
  });
}
