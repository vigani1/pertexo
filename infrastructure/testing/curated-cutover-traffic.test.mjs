import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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
    assert.equal((await fetch(traffic.url)).status, 200);
    await traffic.hold();
    const before = requests;
    assert.equal((await fetch(traffic.url)).status, 503);
    assert.equal(requests, before);
    assert.equal(traffic.snapshot().active, 0);
  } finally {
    await traffic.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
