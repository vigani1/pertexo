import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { users } from '../../schema/foundation.js';

import type { Pool } from 'pg';
import { z } from 'zod';

import type {
  CreateUserInput,
  IdentityWorkspaceDatabase,
  UserRecord,
} from '../contract.js';
import { throwIdentityDatabaseConflict } from '../support.js';
import { userRecord, userSelection } from './projection.js';

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
  const id = input.id ?? generatePersistedId();
  const fields = parseUserIdentityFields(input);
  if (fields.email !== input.email) throw new Error('Invalid user email');
  try {
    const result = await drizzle(pool)
      .insert(users)
      .values({
        id,
        email: fields.email,
        displayName: fields.displayName,
        status: 'active',
      })
      .returning(userSelection)
      .catch(rethrowQueryFailure);
    const row = result[0];
    if (row === undefined) throw new Error('User insertion returned no record');
    return userRecord(row);
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
  const result = await drizzle(pool)
    .select(userSelection)
    .from(users)
    .where(eq(users.id, userId))
    .catch(rethrowQueryFailure);
  const row = result[0];
  return row === undefined ? null : userRecord(row);
}

/** Pertexo's user records; Better Auth owns credentials and sessions. */
export function createUserStore(pool: Pool): UserStore {
  return Object.freeze({
    createUser: (input: CreateUserInput) => createUser(pool, input),
    findUserById: (userId: string) => findUserById(pool, userId),
  });
}
