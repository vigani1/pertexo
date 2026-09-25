import type { WorkflowAuthoringDatabase } from '@pertexo/database/api';
import type {
  ActorContext,
  AuthorizedWorkspaceContext,
} from '../workspaces/index.js';
import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';
import type { WorkflowAuthoringTelemetry } from './telemetry.js';

/** Narrow persistence seam; runtime owns lifecycle, and callers preserve single-snapshot CAS conflicts. */
export type WorkflowAuthoringPersistence = Pick<
  WorkflowAuthoringDatabase,
  | 'createWorkflow'
  | 'listWorkflows'
  | 'getWorkflow'
  | 'getDraft'
  | 'listVersions'
  | 'saveDraft'
  | 'publishWorkflow'
  | 'transitionWorkflowLifecycle'
  | 'renameWorkflow'
  | 'restoreWorkflowVersion'
>;

export type WorkflowAuthoringDependencies = Readonly<{
  persistence: WorkflowAuthoringPersistence;
  authorization: WorkspaceAuthorizationSource;
  telemetry?: WorkflowAuthoringTelemetry;
}>;

export type WorkflowApplicationInput = Readonly<{
  actor: ActorContext;
  routeWorkspaceId: string;
  authorizedWorkspace?: AuthorizedWorkspaceContext;
}>;
