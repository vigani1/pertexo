import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { copyObjectTree } from '../backup/copy-objects.mjs';

test('copies paginated bytes and exact wire metadata, returning the object count', async () => {
  const requests = [];
  const bodies = [];
  const source = {
    bucket: 'source',
    prefix: 'snapshot/',
    client: {
      async send(command) {
        const input = command.input;
        if (!input.Key)
          return input.ContinuationToken
            ? { Contents: [{ Key: 'snapshot/b' }] }
            : {
                Contents: [{ Key: 'snapshot/a' }],
                IsTruncated: true,
                NextContinuationToken: 'page2',
              };
        const Body = Readable.from(['abc']);
        bodies.push(Body);
        return {
          Body,
          ContentLength: 3,
          Metadata: { 'artifact-id': 'opaque', sha256: 'hash' },
          ContentType: 'text/plain',
          ContentEncoding: 'gzip',
          ContentDisposition: 'inline',
          ContentLanguage: 'en',
          CacheControl: 'private',
          ChecksumType: 'FULL_OBJECT',
          ChecksumSHA256: 'checksum',
        };
      },
    },
  };
  const destination = {
    bucket: 'target',
    prefix: '',
    client: {
      async send(command) {
        requests.push(command.input);
        for await (const chunk of command.input.Body)
          assert.equal(chunk, 'abc');
      },
    },
  };
  assert.equal(await copyObjectTree(source, destination), 2);
  assert.deepEqual(
    requests.map((r) => r.Key),
    ['a', 'b'],
  );
  assert.deepEqual(requests[0].Metadata, {
    'artifact-id': 'opaque',
    sha256: 'hash',
  });
  assert.equal(requests[0].ChecksumSHA256, 'checksum');
  assert.equal(requests[0].IfNoneMatch, '*');
  assert.ok(bodies.every((body) => body.destroyed));
});
test('failed writes and invalid lengths close the source stream', async () => {
  for (const length of [3, undefined]) {
    const body = Readable.from(['abc']);
    const source = {
      bucket: 'source',
      prefix: '',
      client: {
        async send(command) {
          return command.input.Key
            ? { Body: body, ContentLength: length }
            : { Contents: [{ Key: 'key' }] };
        },
      },
    };
    const target = {
      bucket: 'target',
      prefix: '',
      client: {
        async send() {
          throw new Error('failed write');
        },
      },
    };
    await assert.rejects(copyObjectTree(source, target));
    assert.ok(body.destroyed);
  }
});
test('rejects escaped prefixes and repeated pagination cursors', async () => {
  const target = {
    bucket: 'target',
    prefix: '',
    client: {
      async send() {
        assert.fail('must not write');
      },
    },
  };
  for (const page of [
    { Contents: [{ Key: 'elsewhere/key' }] },
    { IsTruncated: true, NextContinuationToken: 'same' },
  ]) {
    const source = {
      bucket: 'source',
      prefix: 'snapshot/',
      client: {
        async send() {
          return page;
        },
      },
    };
    await assert.rejects(copyObjectTree(source, target), /escaped|advance/u);
  }
});
