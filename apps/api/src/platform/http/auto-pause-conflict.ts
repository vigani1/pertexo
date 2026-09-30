import type { ApiProblem } from '@pertexo/contracts/errors';
import {
  autoPauseSettingsRevisionSchema,
  workflowPauseRevisionSchema,
  workflowPauseConflictProblemSchema,
  workflowAutoPauseSettingsConflictProblemSchema,
  workspaceAutoPauseSettingsConflictProblemSchema,
  type WorkflowPauseConflictProblem,
  type WorkflowAutoPauseSettingsConflictProblem,
  type WorkspaceAutoPauseSettingsConflictProblem,
} from '@pertexo/contracts/workflow-authoring';

import type { ApplicationError } from './application-error.js';

export type AutoPauseConflictProblem =
  | WorkflowPauseConflictProblem
  | WorkflowAutoPauseSettingsConflictProblem
  | WorkspaceAutoPauseSettingsConflictProblem;

export type AutoPauseConflictRevision =
  | Readonly<{ code: 'workflow.pause_conflict'; currentPauseRevision: string }>
  | Readonly<{
      code: 'workflow.auto_pause_settings_conflict';
      currentSettingsRevision: number;
    }>
  | Readonly<{
      code: 'workspace.auto_pause_settings_conflict';
      currentRevision: number;
    }>;

/** Only the command's own revision may cross the public error boundary.
 * Invalid metadata throws into the filter's fail-closed normalization path.
 */
export function normalizeAutoPauseConflict(
  error: ApplicationError,
): AutoPauseConflictRevision | undefined {
  switch (error.code) {
    case 'workflow.pause_conflict':
      return {
        code: error.code,
        currentPauseRevision: workflowPauseRevisionSchema.parse(
          error.details?.currentPauseRevision,
        ),
      };
    case 'workflow.auto_pause_settings_conflict':
      return {
        code: error.code,
        currentSettingsRevision: autoPauseSettingsRevisionSchema.parse(
          error.details?.currentSettingsRevision,
        ),
      };
    case 'workspace.auto_pause_settings_conflict':
      return {
        code: error.code,
        currentRevision: autoPauseSettingsRevisionSchema.parse(
          error.details?.currentRevision,
        ),
      };
    default:
      return undefined;
  }
}

export function projectAutoPauseConflict(
  base: ApiProblem,
  revision: AutoPauseConflictRevision,
): AutoPauseConflictProblem {
  switch (revision.code) {
    case 'workflow.pause_conflict':
      return workflowPauseConflictProblemSchema.parse({ ...base, ...revision });
    case 'workflow.auto_pause_settings_conflict':
      return workflowAutoPauseSettingsConflictProblemSchema.parse({
        ...base,
        ...revision,
      });
    case 'workspace.auto_pause_settings_conflict':
      return workspaceAutoPauseSettingsConflictProblemSchema.parse({
        ...base,
        ...revision,
      });
  }
}
