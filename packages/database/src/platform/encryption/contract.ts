export type StoredEncryptionKey = Readonly<{
  kind: 'connection' | 'webhook';
  workspaceId: string;
  resourceId: string;
  secretVersionId: string;
  keyReference: string;
  encryptedDataKey: string;
}>;

export type EncryptionKeyRepository = Readonly<{
  read(signal: AbortSignal): AsyncIterable<StoredEncryptionKey>;
  close(): Promise<void>;
}>;
