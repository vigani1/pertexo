import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from './support/it.mjs';

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// S13: the callback's query holds a code and state, so it must bypass nginx's logs.
it.fails(
  'S13 the callback reaches the API through its own Caddy handle',
  () => {
    const caddy = read('Caddyfile');
    const site = caddy.slice(caddy.indexOf('{$APP_HOST} {'));
    const handle =
      /handle \/v1\/connections\/oauth2\/callback \{\s*reverse_proxy api:3000\s*\}/u;
    assert.match(site, handle);
    assert.ok(
      site.search(handle) < site.indexOf('handle {'),
      'it stands above the catch-all, with the other capability paths',
    );
  },
);

// Owners table: both API and worker read HTTP_ALLOWED_PRIVATE_NETWORKS (S17).
it.fails('S17 the API gets HTTP_ALLOWED_PRIVATE_NETWORKS too', () => {
  const compose = read('compose.yaml');
  const services = compose.split(/^ {2}(?=[a-z-]+:$)/mu);
  for (const service of ['api', 'worker']) {
    const block = services.find((part) => part.startsWith(`${service}:`));
    assert.ok(block, `${service} is a service`);
    assert.match(
      block,
      /HTTP_ALLOWED_PRIVATE_NETWORKS: \$\{HTTP_ALLOWED_PRIVATE_NETWORKS:-\}/u,
      service,
    );
  }
});

// D9: the runbook says a restored backup may need a reconnect.
it.fails('D9 the runbook says a restored backup may need reconnecting', () => {
  const runbook = read('../../docs/operations/single-server.md');
  assert.match(runbook, /OAuth2/u);
  assert.match(runbook, /invalid_grant|reconnect/iu);
});
