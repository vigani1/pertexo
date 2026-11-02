import { createHmac, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import { createStructuredLogger } from '@pertexo/observability';
import { createInitialCheckpoint } from '@pertexo/core/execution';
import Fastify from 'fastify';
import { expect, it } from 'vitest';

import { registerWebhookIngress } from '../../../src/webhooks/ingress/register.js';
import {
  catalog,
  encryption,
  ingressDatabase,
  ownerQuery,
  seedWebhook,
} from './fixture.js';

const BODY_WORDS = 'sender-body-words-7f3a';
const QUERY_WORDS = 'sender-query-words-7f3a';
const HEADER_WORDS = 'sender-header-words-7f3a';
const KEY_WORDS = 'sender-idempotency-words-7f3a';

/** The real logger, written somewhere a test can read, in front of the real database. */
async function ingressWithLogs() {
  let written = '';
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      written += chunk.toString();
      done();
    },
  });
  const application = Fastify();
  registerWebhookIngress(application, {
    database: ingressDatabase,
    encryption,
    checkpointFactory: (projection) =>
      createInitialCheckpoint(projection, { catalog }),
    logger: createStructuredLogger(
      {
        serviceName: 'sender-words',
        serviceVersion: 'test',
        environment: 'test',
        logLevel: 'trace',
        otlpHeaders: {},
      },
      destination,
    ),
  });
  await application.ready();
  return { application, logs: () => written };
}

function signed(secret: string, body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    'content-type': 'application/json',
    'idempotency-key': `${KEY_WORDS}-${randomUUID()}`,
    'x-sender-note': HEADER_WORDS,
    'x-pertexo-timestamp': timestamp,
    'x-pertexo-signature': `v1=${createHmac(
      'sha256',
      Buffer.from(secret, 'base64url'),
    )
      .update(`${timestamp}.${body}`)
      .digest('hex')}`,
  };
}

export function registerKeepsSenderWordsOutOfLogs(): void {
  it('logs nothing a sender wrote, even when the database fails on the insert that carries it', async () => {
    const seeded = await seedWebhook(`logs-${randomUUID()}`);
    const { application, logs } = await ingressWithLogs();
    const body = JSON.stringify({ note: BODY_WORDS });
    const url = `/hooks/${seeded.endpointKey}?note=${QUERY_WORDS}`;
    const send = (headers: Record<string, string>) =>
      application.inject({ method: 'POST', url, headers, payload: body });
    // Fails the way an outage or a timeout does: on the statement holding the input.
    await ownerQuery(`
      create function app.test_fail_run_insert() returns trigger language plpgsql as $$
      begin raise exception 'forced failure' using errcode='XX000'; end $$`);
    await ownerQuery(`
      create trigger test_fail_run_insert before insert on app.workflow_runs
      for each row execute function app.test_fail_run_insert()`);
    try {
      const failed = await send(signed(seeded.originalSecret, body));
      expect(failed.statusCode).toBe(503);
      expect(failed.body).not.toContain(BODY_WORDS);
    } finally {
      await ownerQuery(
        'drop trigger test_fail_run_insert on app.workflow_runs',
      );
      await ownerQuery('drop function app.test_fail_run_insert()');
    }
    const wrong = await send({
      ...signed(seeded.originalSecret, body),
      'x-pertexo-signature': `v1=${'0'.repeat(64)}`,
    });
    expect(wrong.statusCode).toBe(401);
    expect((await send(signed(seeded.originalSecret, body))).statusCode).toBe(
      202,
    );
    await application.close();

    const written = logs();
    // The failure was logged, so finding nothing below means something.
    expect(written).toContain('webhook.ingress_failed');
    expect(written).toContain('forced failure');
    for (const words of [
      BODY_WORDS,
      QUERY_WORDS,
      HEADER_WORDS,
      KEY_WORDS,
      seeded.endpointKey,
      seeded.originalSecret,
    ])
      expect(written).not.toContain(words);
  }, 60_000);
}
