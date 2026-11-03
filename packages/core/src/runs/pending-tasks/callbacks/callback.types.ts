import type { CallbackWaitConfig } from '@pertexo/workflow-model';
import type { ExecutionCapabilityScope } from '../../../attempts/dispatch/execution-capability.types.js';
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
export type CallbackPreparation = ExecutionCapabilityScope &
  Readonly<{
    targets: readonly Readonly<{
      nodeId: string;
      config: CallbackWaitConfig;
    }>[];
    keyVersion: string;
    tokenHash: (identity: CallbackIdentity) => string;
    signal: AbortSignal;
  }>;
export type CallbackResponse = Readonly<{
  callback: PreparedCallback;
  output: unknown;
  redactOutput(canonical: string): string;
  signal: AbortSignal;
}>;
