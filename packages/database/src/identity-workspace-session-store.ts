import { randomUUID } from 'node:crypto';

import type { DatabaseError, Pool } from 'pg';
import { z } from 'zod';

import type {
  CreateSessionInput,
  IdentityWorkspaceDatabase,
  SessionRecord,
} from './identity-workspace.js';
import {
  IdentityConflictError,
  IdentityNotFoundError,
} from './identity-workspace-errors.js';
import { mapSession } from './identity-workspace-rows.js';

const uuidSchema = z.uuid();
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

type SessionStore = Pick<
  IdentityWorkspaceDatabase,
  | 'createSession'
  | 'findActiveSessionByDigest'
  | 'revokeSession'
  | 'revokeSessionByDigest'
>;

export function createIdentityWorkspaceSessionStore(pool: Pool): SessionStore {
  return Object.freeze({
    createSession: async (
      input: CreateSessionInput,
    ): Promise<SessionRecord> => {
      const id = uuidSchema.parse(input.id ?? randomUUID());
      const tokenDigest = digestSchema.parse(input.tokenDigest);
      if (
        !(input.expiresAt instanceof Date) ||
        input.expiresAt.getTime() <= Date.now()
      )
        throw new Error('Session expiry must be in the future');
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
            uuidSchema.parse(input.userId),
            tokenDigest,
            input.expiresAt,
            input.userAgent ?? null,
            input.ipAddress ?? null,
          ],
        );
        const row = result.rows[0] as Record<string, unknown> | undefined;
        if (row === undefined)
          throw new IdentityNotFoundError('User is not available');
        return mapSession(row);
      } catch (error: unknown) {
        if (error instanceof IdentityNotFoundError) throw error;
        const code =
          error instanceof Error ? (error as DatabaseError).code : undefined;
        if (code === '23505' || code === '23503')
          throw new IdentityConflictError(
            'Session conflicts with an existing identity record',
            { cause: error },
          );
        throw error;
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
        [uuidSchema.parse(sessionIdInput)],
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
  });
}
