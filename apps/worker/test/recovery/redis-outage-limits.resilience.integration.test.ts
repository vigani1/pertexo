import { afterAll, beforeAll, expect, it } from 'vitest';

import { PASSWORD } from '../support/recovery/api.js';
import {
  describeFaults,
  SCENARIO_LIMIT_MS,
} from '../support/recovery/environment.js';
import { startService, stopService } from '../support/recovery/services.js';
import { startStack, type Stack } from '../support/recovery/stack.js';

/** `identity_start`'s limit per client address, in its 60 s window. */
const ADDRESS_LIMIT = 10;

/**
 * Refusing every sign-in during an outage locks everybody out over a queue being
 * down, and letting them all through lifts the limit on guessing passwords. A real
 * API with a really stopped Redis has to do neither.
 */
describeFaults('sign-in while Redis is stopped', () => {
  let stack: Stack;
  let wrongPassword: number;
  let rightPassword: readonly number[];
  let overLimit: Response;
  let email: string;

  const signIn = (password: string): Promise<Response> =>
    fetch(`${stack.baseUrl}/v1/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:5999',
      },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(30_000),
    });

  beforeAll(async () => {
    stack = await startStack('redis-outage-limits');
    const [user] = await stack.sql<{ email: string }>(
      'select email from app.users limit 1',
    );
    if (user === undefined) throw new Error('Expected the stack’s user');
    email = user.email;

    await stopService('redis');

    wrongPassword = (await signIn('not-the-password')).status;
    const attempts: number[] = [];
    for (let attempt = 1; attempt < ADDRESS_LIMIT + 2; attempt += 1)
      attempts.push((await signIn(PASSWORD)).status);
    rightPassword = attempts;
    overLimit = await signIn(PASSWORD);
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await startService('redis');
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  it('still tells a wrong password apart', () => {
    expect(wrongPassword).toBe(401);
  });

  it('lets a right password in, up to the limit and no further', () => {
    expect(rightPassword).toEqual([
      ...Array.from({ length: ADDRESS_LIMIT - 1 }, () => 200),
      429,
      429,
    ]);
  });

  it('says when to come back', () => {
    expect(overLimit.status).toBe(429);
    const wait = Number(overLimit.headers.get('retry-after'));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
  });
});
