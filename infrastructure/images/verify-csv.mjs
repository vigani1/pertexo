import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';

/** A clean proxy EOF must never hide an upstream export failure. */
export async function verifyCsvProxy({ origin, headers, probe }) {
  const complete = await probe(`${origin}/v1/csv-probe`, headers, {
    method: 'POST',
  });
  assert.equal(complete.status, 200);
  assert.match(complete.headers['content-type'], /text\/csv/u);
  assert.match(complete.headers['content-disposition'], /attachment/u);
  assert.ok(Buffer.byteLength(complete.value) > 1_048_576);
  assert.ok(complete.value.endsWith('"last"\r\n'));
  const key = randomUUID();
  const incoming = await new Promise((resolve, reject) => {
    const outgoing = request(
      `${origin}/v1/csv-probe?fail=${key}`,
      { headers, method: 'POST' },
      resolve,
    );
    outgoing.once('error', reject);
    outgoing.end();
  });
  assert.equal(incoming.statusCode, 200);
  let released = false;
  await assert.rejects(async () => {
    for await (const chunk of incoming) {
      assert.ok(chunk.length > 0);
      if (!released) {
        released = true;
        const release = await probe(
          `${origin}/v1/csv-probe/release?key=${key}`,
          headers,
          { method: 'POST' },
        );
        assert.equal(release.status, 204);
      }
    }
  }, /aborted|premature|reset/iu);
  assert.ok(
    released,
    'The consumer must receive a CSV prefix before the upstream fails',
  );
}
