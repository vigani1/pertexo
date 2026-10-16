import { verifyUnsubscribeProxy } from './verify-unsubscribe.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const [runtimeImage, webImage, caddyImage] = process.argv.slice(2);
if (!runtimeImage || !webImage)
  throw new Error(
    'usage: node verify-web.mjs <runtime-image> <web-image> [cached-caddy-image]',
  );
if (
  ![
    runtimeImage,
    webImage,
    ...(caddyImage === undefined ? [] : [caddyImage]),
  ].every((image) => /^[a-z0-9][a-zA-Z0-9._/:@-]*$/u.test(image))
)
  throw new Error('Expected Docker image references');
const docker = async (args) => {
  const result = await execute('docker', args, { timeout: 30_000 });
  return args[0] === 'logs'
    ? result.stdout + result.stderr
    : result.stdout.trim();
};
const network = `pertexo-web-${randomUUID()}`;
const owned = [];
let failure;

async function readProbe(url, headers, options = {}) {
  const response = await new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      { headers, method: options.method ?? 'GET' },
      resolve,
    );
    request.setTimeout(5_000, () =>
      request.destroy(new Error('Probe timed out')),
    );
    request.once('error', reject);
    request.end(options.body);
  });
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return {
    status: response.statusCode,
    headers: response.headers,
    value: (response.headers['content-type'] ?? '').includes('application/json')
      ? JSON.parse(Buffer.concat(chunks).toString())
      : Buffer.concat(chunks).toString(),
  };
}

await docker(['network', 'create', network]);
try {
  const backend = await docker([
    'run',
    '--detach',
    '--pull',
    'never',
    '--network',
    network,
    '--network-alias',
    'api',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--mount',
    `type=bind,src=${fileURLToPath(new URL('./probe-server.mjs', import.meta.url))},dst=/probe.mjs,readonly`,
    '--entrypoint',
    'node',
    runtimeImage,
    '/probe.mjs',
  ]);
  owned.push(backend);
  const web = await docker([
    'run',
    '--detach',
    '--pull',
    'never',
    '--network',
    network,
    '--network-alias',
    'web',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/etc/nginx/conf.d:uid=101,gid=101,mode=0755',
    '--publish',
    '127.0.0.1::8080',
    webImage,
  ]);
  owned.push(web);
  assert.equal(await docker(['exec', web, 'id', '-u']), '101');
  const bindings = JSON.parse(
    await docker([
      'inspect',
      '--format',
      '{{json .NetworkSettings.Ports}}',
      web,
    ]),
  );
  const origin = `http://127.0.0.1:${bindings['8080/tcp'][0].HostPort}`;
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      const ready = await fetch(`${origin}/v1/probe`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (ready.ok) {
        await ready.arrayBuffer();
        break;
      }
      await ready.body?.cancel();
    } catch {
      // Both owned containers must finish starting before the transport checks.
    }
    if (Date.now() >= deadline)
      throw new Error('Web transport did not become ready');
    await delay(100);
  }
  for (const [forwarded, expected] of [
    ['https', 'https'],
    ['http', 'http'],
    ['', 'http'],
    ['invalid', 'http'],
  ]) {
    const response = await readProbe(`${origin}/v1/probe`, {
      host: 'app.beta.test',
      ...(forwarded ? { 'x-forwarded-proto': forwarded } : {}),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.value, {
      host: 'app.beta.test',
      path: '/v1/probe',
      proto: expected,
    });
  }
  const missingApi = await fetch(`${origin}/v1/missing`);
  assert.equal(missingApi.status, 404);
  await missingApi.body?.cancel();
  const page = await fetch(`${origin}/w/example/workflows`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/u);
  assert.match(
    page.headers.get('content-security-policy'),
    /frame-ancestors 'none'/u,
  );
  // Browsers ask for these at the root; the app's fallback page must not answer.
  for (const [path, type] of [
    ['/favicon.ico', /^image\/(?:x-icon|vnd\.microsoft\.icon)/u],
    ['/apple-touch-icon.png', /^image\/png/u],
    ['/manifest.json', /^application\/json/u],
  ]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type') ?? '', type, path);
    await response.body?.cancel();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${origin}/v1/stream`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/u);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let frame = '';
    while (!frame.includes('\n\n')) {
      const next = await reader.read();
      assert.equal(next.done, false);
      frame += decoder.decode(next.value, { stream: true });
    }
    assert.equal(frame, 'data: first\n\n');
    await reader.cancel();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  if (caddyImage !== undefined)
    await verifyUnsubscribeProxy({
      docker,
      probe: readProbe,
      network,
      backend,
      web,
      caddyImage,
      owned,
    });
  console.log(
    'Web image: non-root, read-only, proxy schemes, SPA boundary, icons and unbuffered SSE passed.',
  );
} catch (error) {
  failure = error;
  for (const container of owned) {
    console.error(
      await docker(['logs', container]).catch(
        () => 'Container logs unavailable',
      ),
    );
  }
} finally {
  const results = await Promise.allSettled(
    owned.map((container) => docker(['rm', '--force', container])),
  );
  results.push(
    ...(await Promise.allSettled([docker(['network', 'rm', network])])),
  );
  const errors = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (errors.length > 0)
    failure = new AggregateError(
      [...(failure === undefined ? [] : [failure]), ...errors],
      'Image probe or owned-resource cleanup failed',
    );
}
if (failure !== undefined) throw failure;
