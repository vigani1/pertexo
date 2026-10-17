import { verifyCsvProxy } from './verify-csv.mjs';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

/** Reuse the image probe's owned network, peers and cleanup; never pull images. */
export async function verifyUnsubscribeProxy({
  docker,
  probe,
  network,
  backend,
  web,
  caddyImage,
  owned,
}) {
  const caddy = await docker([
    'run',
    '--detach',
    '--pull',
    'never',
    '--network',
    network,
    '--read-only',
    '--tmpfs',
    '/data',
    '--tmpfs',
    '/config',
    '--env',
    'APP_HOST=http://app.beta.test',
    '--env',
    'FILES_HOST=http://files.beta.test',
    '--publish',
    '127.0.0.1::80',
    '--mount',
    `type=bind,src=${fileURLToPath(new URL('../single-server/Caddyfile', import.meta.url))},dst=/etc/caddy/Caddyfile,readonly`,
    caddyImage,
  ]);
  owned.push(caddy);
  const ports = JSON.parse(
    await docker([
      'inspect',
      '--format',
      '{{json .NetworkSettings.Ports}}',
      caddy,
    ]),
  );
  const origin = `http://127.0.0.1:${ports['80/tcp'][0].HostPort}`;
  const headers = { host: 'app.beta.test' };
  const deadline = Date.now() + 30000;
  while (true) {
    try {
      const ready = await probe(`${origin}/v1/probe`, headers);
      if (ready.status === 200 && ready.value.host === 'app.beta.test') break;
    } catch {
      /* Owned Caddy must finish starting before routing is qualified. */
    }
    if (Date.now() >= deadline)
      throw new Error('Unsubscribe edge did not become ready');
    await delay(100);
  }
  const signedKey = 'a'.repeat(43);
  const secretKey = 'b'.repeat(43);
  const body = '{\n  "event": "proxy qualification"\n}\n';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature =
    'v1=' +
    createHmac('sha256', Buffer.alloc(32, 4))
      .update(timestamp + '.' + body)
      .digest('hex');
  const signedHeaders = {
    ...headers,
    'content-type': 'application/json',
    'x-pertexo-timestamp': timestamp,
    'x-pertexo-signature': signature,
  };
  const signed = await probe(`${origin}/hooks/${signedKey}`, signedHeaders, {
    method: 'POST',
    body,
  });
  assert.equal(
    signed.status,
    202,
    'Signed webhook must reach API through the edge',
  );
  assert.deepEqual(signed.value, {
    runId: '99999999-9999-4999-8999-999999999999',
    replayed: false,
  });
  const invalidSignature = await probe(
    `${origin}/hooks/${signedKey}`,
    { ...signedHeaders, 'x-pertexo-signature': 'v1=' + '0'.repeat(64) },
    { method: 'POST', body },
  );
  assert.equal(
    invalidSignature.status,
    401,
    'The peer must exercise real authentication',
  );
  const secret = await probe(
    `${origin}/hooks/${secretKey}`,
    { ...headers, 'content-type': 'application/json' },
    { method: 'POST', body },
  );
  assert.equal(
    secret.status,
    202,
    'Secret URL webhook must reach API through the edge',
  );
  const preflight = await probe(
    `${origin}/hooks/${secretKey}`,
    {
      ...headers,
      origin: 'https://caller.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
    { method: 'OPTIONS' },
  );
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers['access-control-allow-origin'],
    'https://caller.example',
  );
  assert.equal(
    preflight.headers['access-control-allow-credentials'],
    undefined,
  );
  const token = 'synthetic_' + randomUUID().replaceAll('-', '');
  const url = `${origin}/v1/notifications/unsubscribe/one-click?token=${token}`;
  const confirmation = await probe(url, headers);
  assert.equal(confirmation.status, 303);
  assert.equal(
    confirmation.headers.location,
    `/notifications/unsubscribe#${token}`,
  );
  const form = { method: 'POST', body: 'List-Unsubscribe=One-Click' };
  const posting = {
    ...headers,
    'content-type': 'application/x-www-form-urlencoded',
  };
  const accepted = await probe(url, posting, form);
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.value, { method: 'POST', body: form.body, token });
  assert.equal(accepted.headers.location, undefined);
  await verifyCsvProxy({ origin, headers, probe });
  await docker(['stop', backend]);
  const failed = await probe(
    url,
    { ...posting, 'x-private-probe': token },
    form,
  );
  assert.equal(failed.status, 502);
  for (const key of [signedKey, secretKey]) {
    const unavailable = await probe(
      `${origin}/hooks/${key}`,
      {
        ...headers,
        'content-type': 'application/json',
        'x-private-probe': key,
      },
      { method: 'POST', body },
    );
    assert.equal(unavailable.status, 502);
  }
  const edgeLogs = await docker(['logs', caddy]);
  assert.match(edgeLogs, /REDACTED/u);
  assert.match(edgeLogs, /502/u);
  assert.ok(
    !edgeLogs.includes(token),
    'Edge error logs must not contain the capability or private header',
  );
  const webLogs = await docker(['logs', web]);
  assert.ok(
    !webLogs.includes(token),
    'Canonical capability requests must bypass nginx logs',
  );
  for (const key of [signedKey, secretKey]) {
    assert.ok(
      !edgeLogs.includes(key),
      'Caddy must redact credential paths, including API-down errors',
    );
    assert.ok(!webLogs.includes(key), 'Webhook credentials must bypass nginx');
  }
  assert.ok(
    !webLogs.includes('/hooks'),
    'nginx must never see the webhook path',
  );
  console.log(
    'Single-server edge: signed/Secret URL webhooks, preflight, one-click and API-down log privacy passed.',
  );
}
