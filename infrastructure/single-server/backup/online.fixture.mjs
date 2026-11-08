import { verifyBackupKey } from './key-check.mjs';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import {
  copySharedObjects,
  restoreSharedObjects,
  collectSharedObjects,
} from './shared-objects.mjs';

export async function qualifyOnlineRecovery({
  rclone,
  raw,
  original,
  store,
  artifacts,
  bodies,
  directory,
  rewriteKeys,
}) {
  const run = async (args) =>
    rclone(
      args.map((arg) =>
        arg.startsWith(directory + '/')
          ? '/backup/' + arg.slice(directory.length + 1)
          : arg,
      ),
      { captureOutput: true },
    );
  writeFileSync(`${directory}/KEYCHECK`, 'Pertexo encrypted backups\n');
  await run(['copyto', `${directory}/KEYCHECK`, 'crypt:KEYCHECK']);
  await verifyBackupKey(run);
  const originalCipher = (
    await raw.client.send(
      new ListObjectsV2Command({ Bucket: raw.bucket, Prefix: 'encrypted/' }),
    )
  ).Contents;
  const first = await copySharedObjects({
    ...original,
    directory,
    rclone: run,
    preCopy: true,
  });
  assert.equal(first.copied, 0, 'capture already saved the original objects');
  const second = await copySharedObjects({
    ...original,
    directory,
    rclone: run,
    knownEntries: first.entries,
  });
  assert.equal(second.copied, 0);
  const id = (offset) =>
    new Date(Date.now() - offset * 86400000)
      .toISOString()
      .replace(/[-:]/gu, '')
      .replace(/\.\d{3}/u, '');
  const point1 = id(1),
    point2 = id(0),
    expired = id(15);
  const publish = async (point, entries) => {
    writeFileSync(`${directory}/objects.json`, JSON.stringify(entries));
    await run([
      'copyto',
      `${directory}/objects.json`,
      `crypt:pertexo-beta/${point}/objects.json`,
    ]);
    writeFileSync(`${directory}/COMPLETE`, 'complete\n');
    await run([
      'copyto',
      `${directory}/COMPLETE`,
      `crypt:pertexo-beta/${point}/COMPLETE`,
    ]);
  };
  await run([
    'copyto',
    `${directory}/database.dump`,
    `crypt:pertexo-beta/${point1}/database.dump`,
  ]);
  await publish(point1, second.entries);
  // The first point must survive loss from the live store, including metadata.
  const removed = second.entries[0];
  await original.client.send(
    new DeleteObjectCommand({ Bucket: original.bucket, Key: removed.key }),
  );
  const marker = Buffer.from('BATCH_I_PLAINTEXT_MARKER_' + randomUUID());
  const added = {
    ...artifacts[0],
    artifactId: randomUUID(),
    byteLength: marker.length,
    sha256: createHash('sha256').update(marker).digest('hex'),
  };
  await store.put({ ...added, body: Readable.from([marker]) });
  const incremental = await copySharedObjects({
    ...original,
    directory,
    rclone: run,
  });
  assert.equal(
    incremental.copied,
    1,
    'second backup copies only the new artifact',
  );
  await publish(point2, incremental.entries);
  const afterIncremental = new Map(
    (
      await raw.client.send(
        new ListObjectsV2Command({ Bucket: raw.bucket, Prefix: 'encrypted/' }),
      )
    ).Contents.map((object) => [object.Key, object.ETag]),
  );
  for (const object of originalCipher)
    assert.equal(
      afterIncremental.get(object.Key),
      object.ETag,
      'existing ciphertext was not rewritten',
    );
  // Give an expired point a unique object. Collection must remove that object,
  // while retaining the live-deleted object still needed by point1.
  writeFileSync(`${directory}/orphan`, 'expired only');
  await run(['copyto', `${directory}/orphan`, 'crypt:objects/expired-only']);
  await publish(expired, [{ ...removed, key: 'expired-only' }]);
  writeFileSync(`${directory}/objects.json`, 'damaged');
  await run([
    'copyto',
    `${directory}/objects.json`,
    `crypt:pertexo-beta/${point2}/objects.json`,
  ]);
  await assert.rejects(collectSharedObjects(run));
  assert.ok(
    (await run(['lsf', 'crypt:objects', '--recursive', '--files-only']))
      .split('\n')
      .includes('expired-only'),
    'damaged kept manifest prevents all collection',
  );
  await publish(point2, incremental.entries);
  await collectSharedObjects(run);
  const retained = await run([
    'lsf',
    'crypt:objects',
    '--recursive',
    '--files-only',
  ]);
  assert.ok(retained.split('\n').includes(removed.key));
  assert.ok(!retained.split('\n').includes('expired-only'));
  const listing = await raw.client.send(
    new ListObjectsV2Command({ Bucket: raw.bucket, Prefix: 'encrypted/' }),
  );
  assert.ok(listing.Contents.length > artifacts.length);
  for (const object of listing.Contents) {
    assert.ok(!object.Key.includes('database.dump'));
    assert.ok(!object.Key.includes(added.artifactId));
    for (const artifact of artifacts)
      assert.ok(!object.Key.includes(artifact.artifactId));
    const response = await raw.client.send(
      new GetObjectCommand({ Bucket: raw.bucket, Key: object.Key }),
    );
    const bytes = Buffer.from(await response.Body.transformToByteArray());
    assert.ok(!bytes.includes(marker), 'bucket has no new plaintext marker');
    for (const body of bodies.values())
      assert.ok(
        !bytes.includes(body),
        'bucket has no original artifact plaintext',
      );
    assert.ok(!bytes.includes(Buffer.from('PGDMP')));
  }
  await run([
    'copyto',
    `crypt:pertexo-beta/${point1}/database.dump`,
    `${directory}/encrypted-restored.dump`,
  ]);
  const dump = readFileSync(`${directory}/encrypted-restored.dump`);
  assert.deepEqual(dump, readFileSync(`${directory}/database.dump`));
  const keys = rewriteKeys('wrong');
  await assert.rejects(
    verifyBackupKey(run),
    /BACKUP_CRYPT_PASSWORD.*BACKUP_CRYPT_SALT/u,
  );
  rewriteKeys('missing');
  await assert.rejects(
    verifyBackupKey(run),
    /BACKUP_CRYPT_PASSWORD.*BACKUP_CRYPT_SALT/u,
  );
  rewriteKeys(keys);
  // Recreate the source from the encrypted point alone. Its oldest object is
  // no longer in the live store and is absent from the newer point.
  for (const entry of incremental.entries)
    await original.client.send(
      new DeleteObjectCommand({ Bucket: original.bucket, Key: entry.key }),
    );
  assert.equal(
    await restoreSharedObjects({
      ...original,
      directory,
      rclone: run,
      entries: second.entries,
    }),
    artifacts.length,
  );
  for (const artifact of artifacts) {
    assert.deepEqual(await store.head(artifact), artifact);
    const download = await store.getStream(artifact);
    const chunks = [];
    for await (const chunk of download.body) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bodies.get(artifact.artifactId));
  }
  console.log(
    'Online encrypted recovery: new-only copies, ciphertext names/bodies, matched dump, missing/wrong crypt keys, live deletion, retained references and expired-only collection passed',
  );
  return dump;
}
