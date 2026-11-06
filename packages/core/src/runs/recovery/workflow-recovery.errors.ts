import type { RecoveryRefused } from '@pertexo/workflow-engine/server';

export class WorkflowRecoveryUnavailableError extends Error {
  public override readonly name = 'WorkflowRecoveryUnavailableError';
  public constructor(public readonly reason: RecoveryRefused['reason']) {
    super('run.recovery_unavailable');
  }
}
