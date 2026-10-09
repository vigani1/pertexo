import { generatePersistedId } from '../../platform/persisted-id.js';

import type { Pool } from 'pg';
import { z } from 'zod';

import { mapUser } from '../rows.js';
import {
  parseIdentityUuid,
  throwIdentityDatabaseConflict,
} from '../support.js';
import type {
  CreateUserInput,
  IdentityWorkspaceDatabase,
  UserRecord,
} from '../contracts.js';

const userIdentityFieldsSchema = z.object({
  email: z.string().trim().min(3).max(320),
  displayName: z.string().trim().min(1).max(256),
});

function parseUserIdentityFields(
  input: Pick<CreateUserInput, 'email' | 'displayName'>,
): z.output<typeof userIdentityFieldsSchema> {
  return userIdentityFieldsSchema.parse(input);
}

type UserStore = Pick<IdentityWorkspaceDatabase, 'createUser' | 'findUserById'>;

async function createUser(
  pool: Pool,
  input: CreateUserInput,
): Promise<UserRecord> {
  const id = parseIdentityUuid(input.id ?? generatePersistedId());
  const fields = parseUserIdentityFields(input);
  if (fields.email !== input.email) throw new Error('Invalid user email');
  try {
    const result = await pool.query(
      `insert into app.users (id, email, display_name, status)
       values ($1, $2, $3, 'active')
       returning id, email, display_name, status, profile_revision, created_at, updated_at`,
      [id, fields.email, fields.displayName],
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
    `select id, email, display_name, status, profile_revision, created_at, updated_at
     from app.users where id = $1`,
    [parseIdentityUuid(userId)],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row === undefined ? null : mapUser(row);
}

/** Pertexo's user records; Better Auth owns credentials and sessions. */
export function createUserStore(pool: Pool): UserStore {
  return Object.freeze({
    createUser: (input: CreateUserInput) => createUser(pool, input),
    findUserById: (userId: string) => findUserById(pool, userId),
  });
}
