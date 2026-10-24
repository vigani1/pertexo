import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { users } from '../../schema/foundation.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { generatePersistedId } from '../../platform/persisted-id.js';

import type { Pool } from 'pg';
import { z } from 'zod';

import { userRecord, userSelection } from './projection.js';
import {
  parseIdentityUuid,
  throwIdentityDatabaseConflict,
} from '../support.js';
import type {
  CreateUserInput,
  IdentityWorkspaceDatabase,
  UserRecord,
} from '../contract.js';

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
    .where(eq(users.id, parseIdentityUuid(userId)))
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
