import type { WorkspaceVariablesStore } from '@pertexo/core/variables';
import { WORKSPACE_VARIABLES_STORE } from './workspace-variables.tokens.js';
import { Controller, Inject, Req, UseInterceptors } from '@nestjs/common';
import { variableRoutes, type RouteInput } from '@pertexo/contracts/server';
import { commandCredential } from '../authorization/credentials.js';
import { projectAuthenticatedWorkspaceContext } from '../workspaces/request/authenticated-context.js';
import { In, Route } from '../workspaces/http/route.js';
import type { IdentityWorkspaceRequest } from '../workspaces/workspace-transport.js';
import { authenticatedRequestIdentifiers } from '../workspaces/request/authenticated-context.js';
import { withRequestOperationSignal } from '../platform/http/index.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';
import { WorkspaceVariablesService } from './workspace-variables.service.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { resourceFailure } from '../problems/context/normalize.js';

type Request = IdentityWorkspaceRequest & AbortableRequest;
@UseInterceptors(domainErrors(resourceFailure))
@Controller()
export class WorkspaceVariablesController {
  constructor(
    @Inject(WORKSPACE_VARIABLES_STORE)
    private readonly store: WorkspaceVariablesStore,
    private readonly variables: WorkspaceVariablesService,
  ) {}
  @Route(variableRoutes.read)
  read(
    @Req() request: Request,
    @In() { params }: RouteInput<typeof variableRoutes.read>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.store.read({
        workspaceId: params.workspaceId,
        actorId: projectAuthenticatedWorkspaceContext(
          request,
          params.workspaceId,
        ).actor.actorId,
        signal,
      }),
    );
  }
  @Route(variableRoutes.usage)
  usage(
    @Req() request: Request,
    @In() { params, query }: RouteInput<typeof variableRoutes.usage>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.variables.usage({
        workspaceId: params.workspaceId,
        actorId: projectAuthenticatedWorkspaceContext(
          request,
          params.workspaceId,
        ).actor.actorId,
        ...query,
        signal,
      }),
    );
  }
  @Route(variableRoutes.replace)
  replace(
    @Req() request: Request,
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof variableRoutes.replace>,
  ) {
    const { actor } = projectAuthenticatedWorkspaceContext(
      request,
      params.workspaceId,
    );
    return withRequestOperationSignal(request, (signal) =>
      this.store.replace({
        workspaceId: params.workspaceId,
        actorId: actor.actorId,
        ...commandCredential(actor),
        ...body,
        idempotencyKey,
        ...authenticatedRequestIdentifiers(request),
        signal,
      }),
    );
  }
}
