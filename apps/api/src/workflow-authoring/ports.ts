import type { WorkflowAuthoringDatabase } from '@pertexo/database';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import type {
  WorkspaceAuthorizationPort,
  ActorContext,
} from '../workspaces/index.js';
import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';
import type { WorkflowAuthoringTelemetry } from './telemetry.js';
import type {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../identity-workspace/guards.js';

/** Narrow application persistence seam; database lifecycle is owned by runtime composition. */
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
  /** Guards are supplied by the identity module; this feature never constructs auth state. */
  sessionAuthenticationGuard: SessionAuthenticationGuard;
  csrfProtectionGuard: CsrfProtectionGuard;
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
