import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { createCuratedCutoverTraffic } from './curated-cutover-traffic.mjs';

test('real HTTP arbiter holds, gates release by readiness, drains and stops forwarding', async () => {
  let requests = 0,
    ready = false;
  const upstream = createServer((request, response) => {
    requests++;
    response.writeHead(
      request.url === '/health/ready' ? (ready ? 200 : 503) : 200,
    );
    response.end('{}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${upstream.address().port}`,
    traffic = await createCuratedCutoverTraffic();
  try {
    assert.equal((await fetch(traffic.url)).status, 503);
    assert.equal(requests, 0);
    await assert.rejects(traffic.release(url), /not ready/);
    assert.equal(traffic.snapshot().held, true);
    ready = true;
    await traffic.release(url);
    for (const target of [
      `//127.0.0.1:${upstream.address().port}/escape`,
      `${url}/escape`,
      '/\\escape',
    ]) {
      const before = requests;
      const status = await new Promise((resolve, reject) => {
        const outgoing = request(
          {
            hostname: '127.0.0.1',
            port: new URL(traffic.url).port,
            path: target,
          },
          (response) => {
            response.resume();
            response.once('end', () => resolve(response.statusCode));
          },
        );
        outgoing.once('error', reject);
        outgoing.end();
      });
      assert.equal(status, 400);
      assert.equal(requests, before, 'request target cannot choose a host');
    }
    assert.equal((await fetch(traffic.url)).status, 200);
    await traffic.hold();
    const before = requests;
    assert.equal((await fetch(traffic.url)).status, 503);
    assert.equal(requests, before);
    assert.equal(traffic.snapshot().active, 0);
    for (const target of [
      'https://127.0.0.1:80',
      'http://localhost:80',
      'http://127.0.0.1:80/path',
      'http://user:password@127.0.0.1:80',
      'http://127.0.0.1:65536',
    ]) {
      await assert.rejects(traffic.release(target), /loopback/);
      assert.equal(traffic.snapshot().held, true);
    }
  } finally {
    await traffic.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
