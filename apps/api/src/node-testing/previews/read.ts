import {
  previewRunResponseSchema,
  type PreviewRunResponse,
} from '@pertexo/contracts';

import { WorkflowNotFoundError } from '@pertexo/core/authoring';

import { authorizeWorkspaceOperation } from '../../authorization/index.js';
import type {
  ActorContext,
  AuthorizedWorkspaceContext,
} from '../../authorization/index.js';

import type { NodeTestingPersistence } from '../ports.js';

import type { Authorization } from '../use-case.js';
import { previewOutputResponse } from './response.js';

export class GetPreviewRunUseCase {
  public constructor(
    private readonly persistence: Pick<NodeTestingPersistence, 'readPreview'>,
    private readonly authorization: Authorization,
  ) {}

  public async execute(
    input: Readonly<{
      actor: ActorContext;
      routeWorkspaceId: string;
      authorizedWorkspace?: AuthorizedWorkspaceContext;
      previewRunId: string;
    }>,
  ): Promise<PreviewRunResponse> {
    await authorizeWorkspaceOperation({
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability: 'workflow:update',
      access: this.authorization,
      disclosure: 'not_found',
      allowedWorkspaceStatuses: ['active'],
      ...(input.authorizedWorkspace === undefined
        ? {}
        : { authorizedWorkspace: input.authorizedWorkspace }),
    });
    const preview = await this.persistence.readPreview({
      workspaceId: input.routeWorkspaceId,
      actorUserId: input.actor.actorId,
      previewRunId: input.previewRunId,
    });
    if (preview === null)
      throw new WorkflowNotFoundError('Preview is not visible');
    return previewRunResponseSchema.parse({
      preview: {
        id: preview.id,
        workspaceId: preview.workspaceId,
        workflowId: preview.workflowId,
        draftRevision: preview.draftRevision,
        nodeId: preview.nodeId,
        status: preview.status,
        disclosure: {
          sideEffectClass: preview.sideEffectClass,
          mayContactProvider: preview.mayContactProvider,
          mayCauseExternalSideEffect: preview.mayCauseExternalSideEffect,
          dryRun: preview.dryRun,
        },
        output: previewOutputResponse(preview.output),
        ...(preview.codeDiagnostics === undefined
          ? {}
          : { codeDiagnostics: preview.codeDiagnostics }),
        ...(preview.errorSummary === undefined
          ? {}
          : { errorSummary: preview.errorSummary }),
        ...(preview.pinnedSampleId == null
          ? {}
          : { pinnedSampleId: preview.pinnedSampleId }),
        safeErrorCode: preview.safeErrorCode,
        createdAt: preview.createdAt.toISOString(),
        startedAt: preview.startedAt?.toISOString() ?? null,
        completedAt: preview.completedAt?.toISOString() ?? null,
        expiresAt: preview.expiresAt.toISOString(),
      },
    });
  }
}
