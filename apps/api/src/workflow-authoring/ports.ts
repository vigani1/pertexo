import type {
  WorkflowAuthoringStore,
  WorkflowCollaborationStore,
  PublicationReviewStore,
  WorkflowPromotionStore,
  WorkflowAutoPauseStore,
  WorkflowConcurrencyStore,
  WorkflowErrorStore,
  WorkflowInputCaseDatabase,
  WorkflowTagDatabase,
  WorkflowFavoriteDatabase,
  WorkflowOrganizationReadDatabase,
  WorkflowFolderDatabase,
  WorkflowOrganizationBatchDatabase,
} from '@pertexo/core/authoring';
import type {
  ActorContext,
  AuthorizedWorkspaceContext,
} from '../authorization/index.js';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import type { WorkflowAuthoringTelemetry } from './telemetry.js';
import type { WorkflowTemplateOriginProjectionResponse } from '@pertexo/contracts';

/** Narrow persistence seam; runtime owns lifecycle, and callers preserve single-snapshot CAS conflicts. */
export type WorkflowAuthoringPersistence = Pick<
  WorkflowAuthoringStore,
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
      ...input: Parameters<WorkflowAuthoringStore['getWorkflow']>
    ) => Promise<Readonly<{
      workflow: NonNullable<
        Awaited<ReturnType<WorkflowAuthoringStore['getWorkflow']>>
      >;
      templateOrigin: WorkflowTemplateOriginProjectionResponse['templateOrigin'];
    }> | null>;
  }>;

export type WorkflowAuthoringDependencies = Readonly<{
  persistence: WorkflowAuthoringPersistence;
  portabilityPersistence?: Pick<
    WorkflowAuthoringStore,
    'exportWorkflow' | 'previewWorkflowImport' | 'importWorkflow'
  >;
  autoPausePersistence?: WorkflowAutoPauseStore;
  concurrencyPersistence?: WorkflowConcurrencyStore;
  errorWorkflowPersistence?: WorkflowErrorStore;
  inputCasePersistence?: WorkflowInputCaseDatabase;
  collaborationPersistence?: WorkflowCollaborationStore;
  promotionPersistence?: WorkflowPromotionStore;
  publicationReviewPersistence?: PublicationReviewStore;
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
