import type { Pool } from 'pg';
import { ACTIVE_WORKSPACE_STATUSES } from '@pertexo/policy';
import { withResourceRunRead } from '../../runs/access.js';
import { readWorkflowRunRow } from '../../runs/commands/workflow-run-records.repository.js';
import { readWorkflowRunFailedSteps } from '../../runs/queries/history/details.repository.js';
import { readExplanationSteps } from '../../runs/queries/explanation-context.repository.js';
import {
  withWorkspaceAccess,
  type WorkspaceActor,
} from '../../shared/access/workspace-access.js';
import { recordAssistantUsage } from './explanation-usage.repository.js';

type ExplanationActor = WorkspaceActor & Readonly<{ runId: string }>;

export type ExplanationStore = ReturnType<typeof createExplanationStore>;

export function createExplanationStore(pool: Pool) {
  return Object.freeze({
    read: (input: ExplanationActor) =>
      withResourceRunRead(pool, input, async (transaction) => {
        const run = await readWorkflowRunRow(transaction, input.runId, {
          includeWorkflowName: false,
        });
        if (run === undefined) return undefined;
        if (run.status !== 'failed') return { kind: 'run_not_failed' as const };
        const failures = await readWorkflowRunFailedSteps(transaction, [
          run.id,
        ]);
        const failedStep = failures.get(run.id) ?? null;
        const recent = await readExplanationSteps(transaction, run);
        const steps = [
          ...new Map(
            recent.map(({ version: _version, ...step }) => [step.id, step]),
          ).values(),
        ];
        return {
          kind: 'failed_run' as const,
          definitionVersion: {
            id: run.workflowVersionId,
            number: recent[0]?.version ?? null,
          },
          status: run.status,
          trigger: run.triggerType,
          failureCode: run.failureReasonCode,
          failedStep,
          steps,
        };
      }),
    recordUsage: (input: Parameters<typeof recordAssistantUsage>[1]) =>
      withWorkspaceAccess(
        pool,
        input,
        {
          mode: 'change',
          capability:
            input.target.purpose === 'explain_run'
              ? 'run:read'
              : 'workflow:read',
          statuses: ACTIVE_WORKSPACE_STATUSES,
        },
        (client) => recordAssistantUsage(client, input),
      ),
  });
}
