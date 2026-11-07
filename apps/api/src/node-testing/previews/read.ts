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

import type { WorkspaceAuthorizationSource } from '../../workspaces/ports.js';
import { previewOutputResponse, previewIdentityResponse } from './response.js';

export class GetPreviewRunUseCase {
  public constructor(
    private readonly persistence: Pick<NodeTestingPersistence, 'readPreview'>,
    private readonly authorization: WorkspaceAuthorizationSource,
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
        ...previewIdentityResponse(preview),
        output: previewOutputResponse(preview.output),
        ...(preview.errorSummary === undefined
          ? {}
          : { errorSummary: preview.errorSummary }),
        safeErrorCode: preview.safeErrorCode,
        startedAt: preview.startedAt?.toISOString() ?? null,
        completedAt: preview.completedAt?.toISOString() ?? null,
      },
    });
  }
}
