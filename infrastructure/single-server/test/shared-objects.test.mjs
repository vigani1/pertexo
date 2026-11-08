import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { restoreSharedObjects } from '../backup/shared-objects.mjs';

test('encrypted restore preserves all stored wire metadata and bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-restore-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('opaque artifact bytes');
  const metadata = {
    ContentType: 'application/pdf',
    ContentEncoding: 'gzip',
    ContentDisposition: 'attachment; filename="invoice.pdf"',
    ContentLanguage: 'sr',
    CacheControl: 'private, max-age=60',
    Metadata: { 'artifact-id': 'original', sha256: 'original-hash' },
  };
  const stored = [];
  const count = await restoreSharedObjects({
    directory,
    bucket: 'fresh-target',
    entries: [
      {
        key: 'workspace/artifact',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        metadata,
      },
    ],
    rclone: async ([, , destination]) => writeFile(destination, bytes),
    client: {
      async send({ input }) {
        const chunks = [];
        for await (const chunk of input.Body) chunks.push(chunk);
        stored.push({ ...input, Body: Buffer.concat(chunks) });
      },
    },
  });
  assert.equal(count, 1);
  assert.deepEqual(stored, [
    {
      Bucket: 'fresh-target',
      Key: 'workspace/artifact',
      Body: bytes,
      ContentLength: bytes.length,
      ...metadata,
      IfNoneMatch: '*',
    },
  ]);
});

test('corrupted encrypted object refuses restore before any target write', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-restore-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stored = [];
  await assert.rejects(
    restoreSharedObjects({
      directory,
      bucket: 'fresh-target',
      entries: [
        {
          key: 'workspace/artifact',
          size: 8,
          sha256: createHash('sha256').update('original').digest('hex'),
          metadata: {},
        },
      ],
      rclone: async ([, , destination]) => writeFile(destination, 'tampered'),
      client: {
        async send({ input }) {
          for await (const chunk of input.Body) stored.push(chunk);
        },
      },
    }),
    /checksum mismatch/u,
  );
  assert.deepEqual(stored, []);
});

test('a vanished live object is tolerated before the dump but refuses final capture', async () => {
  const { copySharedObjects } = await import('../backup/shared-objects.mjs');
  const missing = Object.assign(new Error('Object no longer exists'), {
    $metadata: { httpStatusCode: 404 },
  });
  const configuration = {
    bucket: 'live-store',
    directory: '/unused',
    rclone: async () => '',
    client: {
      async send({ input }) {
        if (!input.Key) return { Contents: [{ Key: 'workspace/removed' }] };
        throw missing;
      },
    },
  };
  assert.deepEqual(
    await copySharedObjects({ ...configuration, preCopy: true }),
    {
      entries: [],
      copied: 0,
    },
  );
  await assert.rejects(
    copySharedObjects(configuration),
    (error) => error === missing,
  );
});
