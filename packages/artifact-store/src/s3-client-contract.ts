import type {
  DeleteObjectCommand,
  DeleteObjectCommandOutput,
  DeleteObjectsCommand,
  DeleteObjectsCommandOutput,
  GetBucketLocationCommand,
  GetBucketLocationCommandOutput,
  GetObjectCommand,
  GetObjectCommandOutput,
  HeadBucketCommand,
  HeadBucketCommandOutput,
  HeadObjectCommand,
  HeadObjectCommandOutput,
  ListObjectVersionsCommand,
  ListObjectVersionsCommandOutput,
  PutObjectCommand,
  PutObjectCommandOutput,
} from '@aws-sdk/client-s3';

export type ObjectStoreS3Command =
  | DeleteObjectCommand
  | DeleteObjectsCommand
  | GetBucketLocationCommand
  | GetObjectCommand
  | HeadBucketCommand
  | HeadObjectCommand
  | ListObjectVersionsCommand
  | PutObjectCommand;

interface SendOptions {
  readonly abortSignal?: AbortSignal;
}

export interface ObjectStoreS3Client {
  destroy(): void;
  send(command: ObjectStoreS3Command, options?: SendOptions): Promise<unknown>;
}

export function sendS3(
  client: ObjectStoreS3Client,
  command: DeleteObjectCommand,
  options?: SendOptions,
): Promise<DeleteObjectCommandOutput>;
export function sendS3(
  client: ObjectStoreS3Client,
  command: DeleteObjectsCommand,
  options?: SendOptions,
): Promise<DeleteObjectsCommandOutput>;
export function sendS3(
  client: ObjectStoreS3Client,
  command: GetBucketLocationCommand,
  options?: SendOptions,
): Promise<GetBucketLocationCommandOutput>;
export function sendS3(
  client: ObjectStoreS3Client,
  command: GetObjectCommand,
  options?: SendOptions,
): Promise<GetObjectCommandOutput>;
export function sendS3(
  client: ObjectStoreS3Client,
  command: HeadBucketCommand,
  options?: SendOptions,
): Promise<HeadBucketCommandOutput>;
export function sendS3(
  client: ObjectStoreS3Client,
  command: HeadObjectCommand,
  options?: SendOptions,
): Promise<HeadObjectCommandOutput>;
export function sendS3(
  client: ObjectStoreS3Client,
  command: ListObjectVersionsCommand,
  options?: SendOptions,
): Promise<ListObjectVersionsCommandOutput>;
export function sendS3(
  client: ObjectStoreS3Client,
  command: PutObjectCommand,
  options?: SendOptions,
): Promise<PutObjectCommandOutput>;
export function sendS3(
  client: ObjectStoreS3Client,
  command: ObjectStoreS3Command,
  options?: SendOptions,
): Promise<unknown> {
  return client.send(command, options);
}
