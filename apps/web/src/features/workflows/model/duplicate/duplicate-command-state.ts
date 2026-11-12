export type DuplicateState = Readonly<{
  kind: 'loading' | 'ready' | 'sending' | 'stale' | 'failed' | 'denied';
  draft?: Readonly<{ revision: number; etag: string }>;
  error?: string | undefined;
}>;
