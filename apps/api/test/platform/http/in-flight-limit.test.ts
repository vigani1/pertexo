import { connect, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applicationFixture,
  cleanAPIBootstrapOwnershipHealthFixture,
  config,
  dependencies,
  logger,
} from '../../bootstrap/fixture.js';
import { createTestApiApplication } from '../../support/api-application.js';

const LIMIT = 2;
const SETTLE_DEADLINE_MILLIS = 2_000;
const SETTLE_STEP_MILLIS = 10;
// A JSON body announced in full but only partly sent keeps its request open.
const ANNOUNCED_BODY_BYTES = 64;

type HttpAnswer = Readonly<{
  status: number;
  headers: Headers;
  body: unknown;
}>;

describe('the API past its in-flight request bound', () => {
  let origin: string;
  const held: Socket[] = [];
  const warn = vi.fn();

  afterEach(async () => {
    for (const socket of held.splice(0)) socket.destroy();
    warn.mockClear();
    await cleanAPIBootstrapOwnershipHealthFixture();
  });

  async function start(): Promise<void> {
    applicationFixture.application = await createTestApiApplication(
      { ...config, inFlightRequestLimit: LIMIT },
      { ...dependencies(), logger: { ...logger, warn } },
    );
    await applicationFixture.application.listen(0, '127.0.0.1');
    const address = applicationFixture.application
      .getHttpServer()
      .address() as { port: number };
    origin = `http://127.0.0.1:${String(address.port)}`;
  }

  /** Starts a POST whose body never finishes, so the API keeps holding it. */
  function holdRequest(): Socket {
    const url = new URL(origin);
    const socket = connect(Number(url.port), url.hostname);
    socket.on('error', () => undefined);
    socket.write(
      [
        'POST /v1/workspaces HTTP/1.1',
        `Host: ${url.host}`,
        'Content-Type: application/json',
        `Content-Length: ${String(ANNOUNCED_BODY_BYTES)}`,
        '',
        '{"name":',
      ].join('\r\n'),
    );
    held.push(socket);
    return socket;
  }

  async function send(path: string): Promise<HttpAnswer> {
    const response = await fetch(`${origin}${path}`);
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text.length > 0 ? (JSON.parse(text) as unknown) : undefined,
    };
  }

  /** The held requests reach the API a moment after their bytes are sent. */
  async function untilBusy(): Promise<HttpAnswer> {
    const deadline = Date.now() + SETTLE_DEADLINE_MILLIS;
    for (;;) {
      const answer = await send('/v1/auth/capabilities');
      if (answer.status === 503 || Date.now() > deadline) return answer;
      await delay(SETTLE_STEP_MILLIS);
    }
  }

  /** Once a held request ends, the API takes requests again. */
  async function untilAdmitted(): Promise<HttpAnswer> {
    const deadline = Date.now() + SETTLE_DEADLINE_MILLIS;
    for (;;) {
      const answer = await send('/v1/auth/capabilities');
      if (answer.status !== 503 || Date.now() > deadline) return answer;
      await delay(SETTLE_STEP_MILLIS);
    }
  }

  it('answers 503 server.busy with Retry-After once the bound is held', async () => {
    await start();
    for (let index = 0; index < LIMIT; index++) holdRequest();

    const busy = await untilBusy();

    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('1');
    expect(busy.headers.get('content-type')).toContain(
      'application/problem+json',
    );
    expect(busy.body).toEqual({
      type: 'urn:pertexo:problem:server.busy',
      title: 'Server busy',
      status: 503,
      code: 'server.busy',
      requestId: busy.headers.get('x-request-id'),
    });
    expect(warn).toHaveBeenCalledWith(
      'http.server_busy',
      expect.objectContaining({ inFlightLimit: LIMIT }),
    );
  });

  it('still answers the health checks while busy', async () => {
    await start();
    for (let index = 0; index < LIMIT; index++) holdRequest();
    expect((await untilBusy()).status).toBe(503);

    const live = await send('/health/live');
    const ready = await send('/health/ready');

    expect(live).toMatchObject({ status: 200, body: { status: 'ok' } });
    expect(ready).toMatchObject({ status: 200, body: { status: 'ready' } });
  });

  it('frees a place when a held request finishes normally', async () => {
    await start();
    const first = holdRequest();
    holdRequest();
    expect((await untilBusy()).status).toBe(503);

    const answered = new Promise<string>((resolve) => {
      let text = '';
      first.on('data', (chunk: Buffer) => {
        text += chunk.toString();
        if (text.includes('\r\n\r\n')) resolve(text);
      });
    });
    first.write(
      `"x"${' '.repeat(ANNOUNCED_BODY_BYTES - '{"name":"x"}'.length)}}`,
    );
    expect(await answered).toMatch(/^HTTP\/1\.1 \d{3}/u);

    expect((await untilAdmitted()).status).toBe(200);
  });

  it('frees every place after error responses', async () => {
    await start();
    for (let index = 0; index < LIMIT * 3; index++)
      expect((await send('/v1/no-such-route')).status).toBe(404);

    expect((await send('/v1/auth/capabilities')).status).toBe(200);
    for (let index = 0; index < LIMIT; index++) holdRequest();
    expect((await untilBusy()).status).toBe(503);
  });

  it('frees a place when the client goes away mid-body', async () => {
    await start();
    const first = holdRequest();
    holdRequest();
    expect((await untilBusy()).status).toBe(503);

    first.destroy();

    expect((await untilAdmitted()).status).toBe(200);
  });
});
