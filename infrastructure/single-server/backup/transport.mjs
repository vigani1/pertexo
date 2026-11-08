import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { S3Client } from '@aws-sdk/client-s3';
import { parseRecoveryStores } from './stores.mjs';
const execute = promisify(execFile);
export async function rclone(args) {
  const { stdout } = await execute('rclone', args, {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
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
