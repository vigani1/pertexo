import type { WorkspaceVariablesStore } from '@pertexo/core/variables';
import { WORKSPACE_VARIABLES_STORE } from './workspace-variables.tokens.js';
import { Controller, Inject, Req, UseInterceptors } from '@nestjs/common';
import { variableRoutes, type RouteInput } from '@pertexo/contracts/server';
import { In, Route } from '../platform/http/route.js';
import type { IdentityWorkspaceRequest } from '../workspaces/workspace-transport.js';
import { withRequestOperationSignal } from '../platform/http/index.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';
import { readUsagePage } from './read-usage-page.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { resourceFailure } from '../problems/context/normalize-context-errors.js';
import {
  Caller,
  requestIdentifiers,
  storeCaller,
  type WorkspaceCaller,
} from '../workspaces/request/caller.js';

type Request = IdentityWorkspaceRequest & AbortableRequest;
@UseInterceptors(domainErrors(resourceFailure))
@Controller()
export class WorkspaceVariablesController {
  constructor(
    @Inject(WORKSPACE_VARIABLES_STORE)
    private readonly store: WorkspaceVariablesStore,
  ) {}
  @Route(variableRoutes.read)
  read(@Req() request: Request, @Caller() caller: WorkspaceCaller) {
    return withRequestOperationSignal(request, (signal) =>
      this.store.read({ ...storeCaller(caller), signal }),
    );
  }
  @Route(variableRoutes.usage)
  usage(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { query }: RouteInput<typeof variableRoutes.usage>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      readUsagePage(this.store, { ...storeCaller(caller), ...query, signal }),
    );
  }
  @Route(variableRoutes.replace)
  replace(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In()
    { body, idempotencyKey }: RouteInput<typeof variableRoutes.replace>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.store.replace({
        ...storeCaller(caller),
        ...body,
        idempotencyKey,
        ...requestIdentifiers(caller),
        signal,
      }),
    );
  }
}
