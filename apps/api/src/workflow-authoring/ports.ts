import type { WorkflowAuthoringDatabase } from '@pertexo/database/api';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import type {
  WorkspaceAuthorizationPort,
  ActorContext,
} from '../workspaces/index.js';
import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';
import type { WorkflowAuthoringTelemetry } from './telemetry.js';

/** Narrow persistence seam; runtime owns lifecycle, and callers preserve single-snapshot CAS conflicts. */
export type WorkflowAuthoringPersistence = Pick<
  WorkflowAuthoringDatabase,
  | 'createWorkflow'
  | 'listWorkflows'
  | 'getDraft'
  | 'getVersion'
  | 'listVersions'
  | 'saveDraft'
  | 'publishWorkflow'
>;

export type WorkflowAuthoringDependencies = Readonly<{
  persistence: WorkflowAuthoringPersistence;
  authorization: WorkspaceAuthorizationSource | WorkspaceAuthorizationPort;
  definitionCatalog?: Readonly<{
    schemaVersion: 1;
    definitions: readonly Readonly<{ key: string; version: number }>[];
  }>;
  telemetry?: WorkflowAuthoringTelemetry;
}>;

export type WorkflowApplicationInput = Readonly<{
  actor: ActorContext;
  routeWorkspaceId: string;
}>;

/** Optional application-owned graph seam for deployments with a registry adapter. */
export interface WorkflowGraphCatalog {
  readonly catalog: WorkflowAuthoringDependencies['definitionCatalog'];
  parseDraft(input: unknown): WorkflowGraphContract;
  validate(input: WorkflowGraphContract): Readonly<{
    ok: boolean;
    issues: readonly Readonly<{
      code: string;
      path: string;
      message: string;
    }>[];
  }>;
}
