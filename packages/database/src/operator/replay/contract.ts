import type { z } from 'zod';
import type { inputSchema } from './input.js';

export interface OperatorRunReplayStore {
  replay(input: z.input<typeof inputSchema>): Promise<
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
