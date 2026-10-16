import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  await docker(['stop', backend]);
  const failed = await probe(
    url,
    { ...posting, 'x-private-probe': token },
    form,
  );
  assert.equal(failed.status, 502);
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
  console.log(
    'One-click edge: exact POST, inert manual GET and API-down log privacy passed.',
  );
}
