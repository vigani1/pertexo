import { once } from 'node:events';
import { connect, createServer, type Socket } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPostgresDestination } from '@pertexo/database/testing';
import { testStackSetting } from '../../../../infrastructure/testing/test-stack.mjs';
import {
  createSecurePostgresClient,
  parseAllowedPrivateNetworks,
} from '../../src/server.js';

let closeDestination = () => Promise.resolve();
let destination: Awaited<ReturnType<typeof createPostgresDestination>>;
beforeAll(async () => {
  destination = await createPostgresDestination(
    testStackSetting('DATABASE_ADMIN_URL'),
  );
  closeDestination = () => destination.close();
});
afterAll(async () => closeDestination());

const verify = (
  client: ReturnType<typeof createSecurePostgresClient>,
  host: string,
) =>
  client.execute(
    { ...destination.credential, host },
    {
      timeoutMillis: 2_000,
      maxRows: 1,
      beforeDispatch: () => Promise.resolve(),
    },
    (session) => session.query('select current_database() as database'),
  );

it('blocks a private database unless the operator allows its address', async () => {
  await expect(
    verify(createSecurePostgresClient(), destination.credential.host),
  ).resolves.toMatchObject({
    kind: 'failed',
    code: 'address_blocked',
  });
});

it('pins the checked address and refuses a changed metadata answer on the next attempt', async () => {
  // DNS is outside the app. The hostname itself cannot resolve through the OS.
  let answer = destination.credential.host;
  const client = createSecurePostgresClient(
    parseAllowedPrivateNetworks('0.0.0.0/0'),
    {
      resolve: () => Promise.resolve([{ address: answer, family: 4 }]),
    },
  );
  await expect(
    verify(client, 'database-rebind.invalid'),
  ).resolves.toMatchObject({
    kind: 'succeeded',
    result: { rows: [{ database: destination.credential.database }] },
  });
  answer = '169.254.169.254';
  await expect(
    verify(client, 'database-rebind.invalid'),
  ).resolves.toMatchObject({
    kind: 'failed',
    code: 'address_blocked',
  });
});

it('rejects an entire answer containing a metadata address before dialing', async () => {
  const client = createSecurePostgresClient(
    parseAllowedPrivateNetworks('0.0.0.0/0'),
    {
      resolve: () =>
        Promise.resolve([
          { address: destination.credential.host, family: 4 },
          { address: '169.254.169.254', family: 4 },
        ]),
    },
  );
  await expect(verify(client, 'mixed-database.invalid')).resolves.toMatchObject(
    {
      kind: 'failed',
      code: 'address_blocked',
    },
  );
});

it('refuses plaintext on public addresses even when a broad network is allowed', async () => {
  const client = createSecurePostgresClient(
    parseAllowedPrivateNetworks('0.0.0.0/0'),
    { resolve: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]) },
  );
  await expect(
    verify(client, 'public-database.invalid'),
  ).resolves.toMatchObject({
    kind: 'failed',
    code: 'tls_failed',
  });
});

it('returns a safe connection problem when DNS has no answer', async () => {
  const client = createSecurePostgresClient([], {
    resolve: () => Promise.resolve([]),
  });
  await expect(
    verify(client, 'missing-database.invalid'),
  ).resolves.toMatchObject({
    kind: 'failed',
    code: 'connection_failed',
  });
});

it('returns cancellation before opening the destination', async () => {
  const client = createSecurePostgresClient(
    parseAllowedPrivateNetworks('127.0.0.1/32'),
  );
  await expect(
    client.execute(
      destination.credential,
      {
        timeoutMillis: 2_000,
        maxRows: 1,
        signal: AbortSignal.abort(),
        beforeDispatch: () => Promise.resolve(),
      },
      (session) => session.query('select 1'),
    ),
  ).resolves.toMatchObject({ kind: 'failed', code: 'canceled' });
});

it('releases the socket even when the destination leaves its side open', async () => {
  const sockets: Socket[] = [];
  const relay = createServer({ allowHalfOpen: true }, (downstream) => {
    const upstream = connect({
      host: destination.credential.host,
      port: destination.credential.port,
    });
    sockets.push(downstream, upstream);
    downstream.pipe(upstream);
    upstream.pipe(downstream, { end: false });
  });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  try {
    const address = relay.address();
    if (address === null || typeof address === 'string')
      throw new Error('Test relay did not listen');
    const client = createSecurePostgresClient(
      parseAllowedPrivateNetworks('127.0.0.1/32'),
    );
    const deadline = AbortSignal.timeout(3_000);
    const interrupted = new Promise<never>((_resolve, reject) => {
      deadline.addEventListener(
        'abort',
        () => {
          reject(new Error('PostgreSQL client waited for the relay to close'));
        },
        { once: true },
      );
    });
    await expect(
      Promise.race([
        interrupted,
        client.execute(
          { ...destination.credential, host: '127.0.0.1', port: address.port },
          {
            timeoutMillis: 2_000,
            maxRows: 1,
            beforeDispatch: () => Promise.resolve(),
          },
          (session) => session.query('select 1 as value'),
        ),
      ]),
    ).resolves.toMatchObject({
      kind: 'succeeded',
      result: { rows: [{ value: 1 }] },
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      relay.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }
});
