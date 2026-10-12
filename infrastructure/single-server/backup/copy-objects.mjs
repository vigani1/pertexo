import { pathToFileURL } from 'node:url';
import { parseRecoveryStores } from './stores.mjs';
import { parseRecoveryPoint } from './recovery-points.mjs';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

// Copy S3 wire metadata verbatim. General sync tools add their own user fields,
// which would change Pertexo's stored artifact format.
export async function copyObjectTree(source, destination) {
  let token;
  let copied = 0;
  const seenTokens = new Set();
  for (;;) {
    const page = await source.client.send(
      new ListObjectsV2Command({
        Bucket: source.bucket,
        Prefix: source.prefix,
        ContinuationToken: token,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (
        typeof object.Key !== 'string' ||
        !object.Key.startsWith(source.prefix)
      )
        throw new Error('Object listing escaped its source prefix');
      const response = await source.client.send(
        new GetObjectCommand({
          Bucket: source.bucket,
          Key: object.Key,
          ChecksumMode: 'ENABLED',
        }),
      );
      try {
        if (
          !response.Body ||
          !Number.isSafeInteger(response.ContentLength) ||
          response.ContentLength < 0
        )
          throw new Error('Object body or length is missing');
        await destination.client.send(
          new PutObjectCommand({
            Bucket: destination.bucket,
            Key: destination.prefix + object.Key.slice(source.prefix.length),
            Body: response.Body,
            ContentLength: response.ContentLength,
            ContentType: response.ContentType,
            ContentEncoding: response.ContentEncoding,
            ContentDisposition: response.ContentDisposition,
            ContentLanguage: response.ContentLanguage,
            CacheControl: response.CacheControl,
            Metadata: response.Metadata,
            IfNoneMatch: '*',
            ...(response.ChecksumType === 'FULL_OBJECT' &&
            response.ChecksumSHA256
              ? { ChecksumSHA256: response.ChecksumSHA256 }
              : {}),
          }),
        );
        copied++;
      } finally {
        response.Body?.destroy();
      }
    }
    if (!page.IsTruncated) return copied;
    if (
      !page.NextContinuationToken ||
      seenTokens.has(page.NextContinuationToken)
    )
      throw new Error('Object listing did not advance');
    token = page.NextContinuationToken;
    seenTokens.add(token);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [mode, id] = process.argv.slice(2);
  if (mode !== 'backup' && mode !== 'restore')
    throw new Error('usage: copy-objects.mjs backup|restore <recovery-point>');
  const point = parseRecoveryPoint(id);
  const stores = parseRecoveryStores(process.env);
  const clients = Object.fromEntries(
    Object.entries(stores).map(([name, config]) => [
      name,
      new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        forcePathStyle: true,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        requestChecksumCalculation: 'WHEN_REQUIRED',
        requestHandler: { requestTimeout: 120000 },
      }),
    ]),
  );
  const primary = {
    client: clients.source,
    bucket: stores.source.bucket,
    prefix: '',
  };
  const saved = {
    client: clients.backup,
    bucket: stores.backup.bucket,
    prefix: `pertexo-beta/${point.id}/objects/`,
  };
  try {
    const count = await copyObjectTree(
      mode === 'backup' ? primary : saved,
      mode === 'backup' ? saved : primary,
    );
    process.stdout.write(count + '\n');
  } finally {
    for (const client of Object.values(clients)) client.destroy();
  }
}
