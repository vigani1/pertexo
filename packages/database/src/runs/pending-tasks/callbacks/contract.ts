import type { CallbackWaitConfig } from '@pertexo/workflow-model';
import type { ExecutionCapabilityScope } from '../../../attempts/dispatch/contract.js';
export type CallbackIdentity = Readonly<{
  id: string;
  workspaceId: string;
  runId: string;
  nodeId: string;
  scopeHash: string;
}>;
export type PreparedCallback = CallbackIdentity &
  Readonly<{
    keyVersion: string;
    tokenHash: string;
    config: CallbackWaitConfig;
  }>;
export class CallbackCapacityError extends Error {
  override readonly name = 'CallbackCapacityError';
  constructor() {
    super(
      'This workspace has too many pending tasks. Wait for a task to finish before preparing another callback.',
    );
  }
}
export class CallbackResponseError extends Error {
  override readonly name = 'CallbackResponseError';
  constructor(readonly reason: 'resolved' | 'closed') {
    super('This callback cannot be accepted.');
  }
}
export interface CallbackStore {
  prepare(
    input: ExecutionCapabilityScope &
      Readonly<{
        targets: readonly Readonly<{
          nodeId: string;
          config: CallbackWaitConfig;
        }>[];
        keyVersion: string;
        tokenHash: (identity: CallbackIdentity) => string;
        signal: AbortSignal;
      }>,
  ): Promise<readonly PreparedCallback[]>;
  resolve(
    tokenHash: string,
    signal: AbortSignal,
  ): Promise<(PreparedCallback & Readonly<{ databaseTime: Date }>) | null>;
  respond(
    input: Readonly<{
      callback: PreparedCallback;
      output: unknown;
      redactOutput(canonical: string): string;
      signal: AbortSignal;
    }>,
  ): Promise<void>;
  keysInUse(
    signal: AbortSignal,
  ): AsyncIterable<
    Readonly<{ id: string; keyVersion: string; tokenHash: string }>
  >;
  close(): Promise<void>;
}
