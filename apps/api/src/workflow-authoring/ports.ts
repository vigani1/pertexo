import type {
  WorkflowAuthoringDatabase,
  WorkflowAutoPauseDatabase,
  WorkflowConcurrencyDatabase,
  WorkflowInputCaseDatabase,
  WorkflowTagDatabase,
  WorkflowFavoriteDatabase,
  WorkflowOrganizationReadDatabase,
  WorkflowFolderDatabase,
  WorkflowOrganizationBatchDatabase,
} from '@pertexo/database/authoring';
import type {
  ActorContext,
  AuthorizedWorkspaceContext,
} from '../authorization/index.js';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import type { WorkflowAuthoringTelemetry } from './telemetry.js';
import type { WorkflowTemplateOriginProjectionResponse } from '@pertexo/contracts';

/** Narrow persistence seam; runtime owns lifecycle, and callers preserve single-snapshot CAS conflicts. */
export type WorkflowAuthoringPersistence = Pick<
  WorkflowAuthoringDatabase,
  | 'createWorkflow'
  | 'duplicateWorkflow'
  | 'listWorkflows'
  | 'getWorkflow'
  | 'getDraft'
  | 'validateDraft'
  | 'listVersions'
  | 'saveDraft'
  | 'publishWorkflow'
  | 'transitionWorkflowLifecycle'
  | 'renameWorkflow'
  | 'restoreWorkflowVersion'
> &
  Readonly<{
    /** Additive reader capability: absence is unavailable, never origin-null. */
    getWorkflowWithTemplateOrigin?: (
      ...input: Parameters<WorkflowAuthoringDatabase['getWorkflow']>
    ) => Promise<Readonly<{
      workflow: NonNullable<
        Awaited<ReturnType<WorkflowAuthoringDatabase['getWorkflow']>>
      >;
      templateOrigin: WorkflowTemplateOriginProjectionResponse['templateOrigin'];
    }> | null>;
  }>;

export type WorkflowAuthoringDependencies = Readonly<{
  persistence: WorkflowAuthoringPersistence;
  portabilityPersistence?: Pick<
    WorkflowAuthoringDatabase,
    'exportWorkflow' | 'previewWorkflowImport' | 'importWorkflow'
  >;
  autoPausePersistence?: WorkflowAutoPauseDatabase;
  concurrencyPersistence?: WorkflowConcurrencyDatabase;
  inputCasePersistence?: WorkflowInputCaseDatabase;
  organization: Readonly<{
    tags: WorkflowTagDatabase;
    favorites: WorkflowFavoriteDatabase;
    reader: WorkflowOrganizationReadDatabase;
    folders: WorkflowFolderDatabase;
    batches: WorkflowOrganizationBatchDatabase;
  }>;
  authorization: WorkspaceAuthorizationSource;
  telemetry?: WorkflowAuthoringTelemetry;
}>;

export type WorkflowApplicationInput = Readonly<{
  actor: ActorContext;
  routeWorkspaceId: string;
  authorizedWorkspace?: AuthorizedWorkspaceContext;
}>;
