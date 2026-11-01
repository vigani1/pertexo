import { randomUUID } from 'node:crypto';

import type { IdentityWorkspaceDatabase } from '@pertexo/core/testing';

import { expect } from 'vitest';

import { emailDomain } from './environment.js';
import type { SessionCookies } from './contract.js';

export function mutationHeaders(
  cookies: SessionCookies,
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return {
    cookie: cookies.cookieHeader,
    'x-csrf-token': cookies.csrf,
    'idempotency-key': `lifecycle-${randomUUID()}`,
    ...extra,
  };
}

export function expectProblem(
  response: Readonly<{
    statusCode: number;
    payload: string;
    headers: Readonly<Record<string, unknown>>;
    json(): unknown;
  }>,
  status: number,
  code: string,
): void {
  expect(response.statusCode, response.payload).toBe(status);
  expect(String(response.headers['content-type'])).toContain(
    'application/problem+json',
  );
  expect(response.json()).toMatchObject({
    type: `urn:pertexo:problem:${code}`,
    status,
    code,
  });
}

export async function resolveIdentity(
  database: IdentityWorkspaceDatabase,
  subject: string,
) {
  return {
    user: await database.createUser({
      email: `${subject}-${randomUUID()}@${emailDomain}`,
      displayName: `Lifecycle ${subject}`,
    }),
  };
}
