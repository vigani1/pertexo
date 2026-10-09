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
} from '../workspaces/index.js';
import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';
import type { WorkflowAuthoringTelemetry } from './telemetry.js';
import type { WorkflowTemplateOriginProjectionResponse } from '@pertexo/contracts/workflow-authoring';
import type { WorkflowOrganizationCursorCodec } from './organization-cursor.js';
import type { WorkflowOrganizationPageCursorCodec } from './organization-page-cursor.js';

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
  organization?: Readonly<{
    tags: WorkflowTagDatabase;
    favorites: WorkflowFavoriteDatabase;
    reader: WorkflowOrganizationReadDatabase;
    /** Missing follow-on adapters stay unavailable in explicit older test seams. */
    folders?: WorkflowFolderDatabase;
    batches?: WorkflowOrganizationBatchDatabase;
    cursors: Readonly<{
      workflows: WorkflowOrganizationCursorCodec;
      pages: WorkflowOrganizationPageCursorCodec;
    }>;
  }>;
  authorization: WorkspaceAuthorizationSource;
  telemetry?: WorkflowAuthoringTelemetry;
}>;

export type WorkflowApplicationInput = Readonly<{
  actor: ActorContext;
  routeWorkspaceId: string;
  authorizedWorkspace?: AuthorizedWorkspaceContext;
}>;
