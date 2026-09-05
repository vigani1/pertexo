import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import type {
  GetObjectCommandOutput,
  HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';

import { sendS3 } from '../src/s3-client-contract.js';
import type { ObjectStoreS3Client } from '../src/s3-client-contract.js';

declare const client: ObjectStoreS3Client;

const getOutput: Promise<GetObjectCommandOutput> = sendS3(
  client,
  new GetObjectCommand({ Bucket: 'bucket', Key: 'key' }),
);
void getOutput;

const headOutput: Promise<HeadObjectCommandOutput> = sendS3(
  client,
  new HeadObjectCommand({ Bucket: 'bucket', Key: 'key' }),
);
void headOutput;

void sendS3(
  client,
  new HeadObjectCommand({ Bucket: 'bucket', Key: 'key' }),
).then(
  (output) => {
    // @ts-expect-error A HEAD result cannot expose a GET response body.
    void output.Body;
  },
  () => undefined,
);

// @ts-expect-error Unsupported commands require an explicit typed adapter.
void sendS3(client, new CopyObjectCommand({ Bucket: 'bucket', Key: 'key' }));
