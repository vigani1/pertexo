import { WORKFLOW_EDITOR_ROLES } from '@pertexo/policy';
import { writeTriggerPause } from '../../../triggers/pause/write-pause.repository.js';
import { WorkflowNotFoundError } from '../../workflows/workflow-authoring.errors.js';
import type {
  AutoPauseCommandResult,
  ChangeWorkflowPauseInput,
  Transact,
  WorkflowAutoPauseSettings,
} from './auto-pause-settings.types.js';
import { workflowSettings } from './auto-pause-receipts.schemas.js';
import { workflowSettingsOf } from './auto-pause-state.repository.js';
import { WorkflowPauseRevisionConflictError } from './auto-pause.errors.js';
import { lockWorkflow } from './lock-settings.js';
import { writeWorkflowResume } from './resume-workflow.repository.js';
import { command } from './settings-command.js';

export function changeWorkflowPause(
  transact: Transact,
  input: ChangeWorkflowPauseInput,
  intent: 'pause' | 'resume',
): Promise<AutoPauseCommandResult<WorkflowAutoPauseSettings>> {
  const workflowId = input.workflowId;
  const request = {
    expectedPauseRevision: input.expectedPauseRevision,
  };
  return command(transact, input, {
    operation:
      intent === 'pause'
        ? 'workflow.autopause.pause'
        : 'workflow.autopause.resume',
    receipt: workflowSettings,
    resourceId: workflowId,
    workflowId,
    roles: WORKFLOW_EDITOR_ROLES,
    capability: 'workflow:publish',
    request,
    exclusive: false,
    apply: async (client, workspace) => {
      const current = await lockWorkflow(client, input.workspaceId, workflowId);
      if (current.triggerPauseRevision !== request.expectedPauseRevision)
        throw new WorkflowPauseRevisionConflictError(
          current.triggerPauseRevision,
        );
      if ((current.triggerPauseState === 'paused') === (intent === 'pause'))
        return { settings: workflowSettingsOf(current, workspace) };
      if (intent === 'pause') {
        if (current.publishedVersionId === null)
          throw new WorkflowNotFoundError(
            'The workflow has no published version',
          );
        await writeTriggerPause(client, input, {
          kind: 'manual',
          actorId: input.actorId,
        });
        return {
          settings: workflowSettingsOf(
            await lockWorkflow(client, input.workspaceId, workflowId),
            workspace,
          ),
          audit: { action: 'workflow.triggers_paused', targetType: 'workflow' },
        };
      }
      const updated = await writeWorkflowResume(
        client,
        input.workspaceId,
        workflowId,
        current,
      );
      return {
        settings: workflowSettingsOf(updated, workspace),
        audit: { action: 'workflow.triggers_resumed', targetType: 'workflow' },
      };
    },
  });
}
