import type { Input } from './input.js';

export interface OperatorRunReplayStore {
  replay(input: Input): Promise<
    Readonly<{
      kind: 'duplicate' | 'processed';
      runId?: string;
    }>
  >;
  fail(
    input: Readonly<{
      commandId: string;
      safeErrorCode: string;
      workspaceId: string;
    }>,
  ): Promise<void>;
  close(): Promise<void>;
}
