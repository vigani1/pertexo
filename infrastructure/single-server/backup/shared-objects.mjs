import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

const fields = [
  'ContentType',
  'ContentEncoding',
  'ContentDisposition',
  'ContentLanguage',
  'CacheControl',
  'Metadata',
];
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function parseObjectManifest(text) {
  const entries = JSON.parse(text);
  if (!Array.isArray(entries))
    throw new Error('Recovery object manifest must be an array');
  const seen = new Set();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.key !== 'string' ||
      !entry.key ||
      /[\r\n]/u.test(entry.key) ||
      entry.key.startsWith('/') ||
      entry.key
        .split('/')
        .some((part) => !part || part === '.' || part === '..') ||
      seen.has(entry.key) ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !entry.metadata ||
      Array.isArray(entry.metadata) ||
      typeof entry.metadata !== 'object'
    )
      throw new Error('Recovery object manifest entry is invalid');
    for (const [key, value] of Object.entries(entry.metadata)) {
      if (
        !fields.includes(key) ||
        (key === 'Metadata'
          ? !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            Object.values(value).some((item) => typeof item !== 'string')
          : typeof value !== 'string')
      )
        throw new Error('Recovery object metadata is invalid');
    }
    seen.add(entry.key);
  }
  return entries;
}

async function listKeys(client, bucket) {
  const keys = [];
  let token;
  const seen = new Set();
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    for (const object of page.Contents ?? []) {
      if (typeof object.Key !== 'string')
        throw new Error('Object listing has no key');
      keys.push(object.Key);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && (!token || seen.has(token)))
      throw new Error('Object listing did not advance');
    seen.add(token);
  } while (token);
  return keys;
}

/** The rclone callback is the transport boundary; metadata stays inside crypt. */
export async function copySharedObjects({
  client,
  bucket,
  directory,
  rclone,
  preCopy = false,
  knownEntries = [],
}) {
  const saved = new Set(
    (await rclone(['lsf', 'crypt:metadata', '--recursive', '--files-only']))
      .trim()
      .split('\n')
      .filter(Boolean),
  );
  const bodies = new Set(
    (await rclone(['lsf', 'crypt:objects', '--recursive', '--files-only']))
      .trim()
      .split('\n')
      .filter(Boolean),
  );
  const known = new Map(knownEntries.map((entry) => [entry.key, entry]));
  const entries = [];
  let copied = 0;
  for (const key of await listKeys(client, bucket)) {
    const descriptor = `${directory}/object.json`;
    if (saved.has(key) && bodies.has(key)) {
      if (known.has(key)) {
        entries.push(known.get(key));
        continue;
      }
      await rclone(['copyto', `crypt:metadata/${key}`, descriptor]);
      const [entry] = parseObjectManifest(
        `[${await readFile(descriptor, 'utf8')}]`,
      );
      if (entry.key !== key) throw new Error('Saved object identity mismatch');
      entries.push(entry);
      continue;
    }
    let response;
    try {
      response = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
    } catch (error) {
      if (preCopy && error.$metadata?.httpStatusCode === 404) continue;
      throw error;
    }
    const file = `${directory}/object.body`;
    if (!response.Body) throw new Error('Artifact body is missing');
    await pipeline(response.Body, createWriteStream(file, { mode: 0o600 }));
    const entry = {
      key,
      size: response.ContentLength,
      sha256: await sha256(file),
      metadata: Object.fromEntries(
        fields
          .filter((field) => response[field] !== undefined)
          .map((field) => [field, response[field]]),
      ),
    };
    parseObjectManifest(JSON.stringify([entry]));
    await rclone(['copyto', file, `crypt:objects/${key}`]);
    await rclone([
      'copyto',
      `crypt:objects/${key}`,
      `${directory}/object.check`,
    ]);
    if ((await sha256(`${directory}/object.check`)) !== entry.sha256)
      throw new Error('Uploaded object checksum mismatch');
    await writeFile(descriptor, JSON.stringify(entry), { mode: 0o600 });
    await rclone(['copyto', descriptor, `crypt:metadata/${key}`]);
    entries.push(entry);
    copied++;
    await rm(file);
    await rm(`${directory}/object.check`);
  }
  return { entries, copied };
}

export async function restoreSharedObjects({
  client,
  bucket,
  directory,
  rclone,
  entries,
}) {
  for (const entry of entries) {
    const file = `${directory}/object.body`;
    await rclone(['copyto', `crypt:objects/${entry.key}`, file]);
    if ((await sha256(file)) !== entry.sha256)
      throw new Error('Recovery object checksum mismatch');
    const body = createReadStream(file);
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: entry.key,
          Body: body,
          ContentLength: entry.size,
          ...entry.metadata,
          IfNoneMatch: '*',
        }),
      );
    } finally {
      body.destroy();
    }
    await rm(file);
  }
  return entries.length;
}

export async function collectSharedObjects(rclone, now = Date.now()) {
  const points = (await rclone(['lsf', 'crypt:pertexo-beta', '--dirs-only']))
    .trim()
    .split('\n')
    .filter(Boolean);
  const needed = new Set();
  const expired = [];
  for (const point of points) {
    const { parseRecoveryPoint } = await import('./recovery-points.mjs');
    const parsed = parseRecoveryPoint(point.replace(/\/$/u, ''));
    if (parsed.time < now - 14 * 86400000) {
      expired.push(parsed.id);
      continue;
    }
    const files = (
      await rclone(['lsf', `crypt:pertexo-beta/${parsed.id}`, '--files-only'])
    )
      .trim()
      .split('\n');
    if (!files.includes('COMPLETE')) continue;
    // Missing or damaged manifests stop collection before any deletion.
    const entries = parseObjectManifest(
      await rclone(['cat', `crypt:pertexo-beta/${parsed.id}/objects.json`]),
    );
    for (const entry of entries) needed.add(entry.key);
  }
  for (const point of expired)
    await rclone(['purge', `crypt:pertexo-beta/${point}`]);
  for (const area of ['objects', 'metadata']) {
    const keys = (
      await rclone(['lsf', `crypt:${area}`, '--recursive', '--files-only'])
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const key of keys)
      if (!needed.has(key))
        await rclone(['deletefile', `crypt:${area}/${key}`]);
  }
}
