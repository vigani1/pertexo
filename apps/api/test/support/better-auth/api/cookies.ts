import { expect } from 'vitest';

import type { Browser, Reply } from './contract.js';

function setCookies(reply: Reply): string[] {
  const header = reply.headers['set-cookie'];
  return Array.isArray(header) ? header : [header ?? ''];
}

export function setCookie(reply: Reply, name: string): string {
  const cookie = setCookies(reply).find((value) =>
    value.startsWith(`${name}=`),
  );
  const value = cookie?.split(';', 1)[0]?.slice(name.length + 1);
  if (value === undefined || value === '')
    throw new Error(`${name} cookie was not returned`);
  return value;
}

export function browserFrom(reply: Reply): Browser {
  const session = setCookie(reply, 'pertexo_session');
  const csrf = decodeURIComponent(setCookie(reply, 'pertexo_csrf'));
  return {
    session,
    csrf,
    cookie: `pertexo_session=${session}; pertexo_csrf=${encodeURIComponent(csrf)}`,
  };
}

export function expectProblem(
  reply: Reply,
  status: number,
  code: string,
): void {
  expect(reply.statusCode, reply.payload).toBe(status);
  expect(reply.json()).toMatchObject({ status, code });
}
