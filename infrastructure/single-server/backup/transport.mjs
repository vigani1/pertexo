import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { S3Client } from '@aws-sdk/client-s3';
import { parseRecoveryStores } from './stores.mjs';

export async function rclone(args) {
  const directory = process.env.BACKUP_TRANSPORT_DIRECTORY ?? '/backup';
  await writeFile(
    `${directory}/transport.request.tmp`,
    args.join('\0') + '\0',
    { mode: 0o600 },
  );
  await rename(
    `${directory}/transport.request.tmp`,
    `${directory}/transport.request`,
  );
  for (;;) {
    let status;
    try {
      status = await readFile(`${directory}/transport.status`, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await setTimeout(50);
      continue;
    }
    const stdout = await readFile(`${directory}/transport.stdout`, 'utf8');
    const stderr = await readFile(`${directory}/transport.stderr`, 'utf8');
    await rm(`${directory}/transport.status`);
    if (status !== '0') throw new Error(`rclone exited ${status}: ${stderr}`);
    return stdout;
  }
}
export function sourceClient(environment) {
  const { source } = parseRecoveryStores(environment);
  return {
    bucket: source.bucket,
    client: new S3Client({
      endpoint: source.endpoint,
      region: source.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: source.accessKeyId,
        secretAccessKey: source.secretAccessKey,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      requestHandler: { requestTimeout: 120000 },
    }),
  };
}
