import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  federationRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { withRequestOperationSignal } from '../../../platform/http/index.js';
import { domainErrors } from '../../../platform/http/problems/interceptor.js';
import { resourceFailure } from '../../../problems/context/normalize-context-errors.js';
import { In, Route } from '../../../platform/http/route.js';
import {
  federationCommand,
  type FederationCommandScope,
  type FederationManagementRequest,
} from './federation-request.js';
import { FederationManagementService } from './federation-management.service.js';
import {
  Caller,
  storeCaller,
  type WorkspaceCaller,
} from '../../../workspaces/request/caller.js';

type Request = FederationManagementRequest;
@UseInterceptors(domainErrors(resourceFailure))
@Controller()
export class FederationManagementController {
  constructor(private readonly service: FederationManagementService) {}
  private command<T>(
    request: Request,
    caller: WorkspaceCaller,
    input: Pick<RouteInput<typeof routes.create>, 'params' | 'idempotencyKey'>,
    work: (scope: FederationCommandScope) => Promise<T>,
  ) {
    return federationCommand(
      request,
      caller,
      {
        idempotencyKey: input.idempotencyKey,
      },
      (scope) => {
        this.service.requireConfigured();
        return work(scope);
      },
    );
  }
  @Route(routes.settings)
  settings(@Req() request: Request, @Caller() caller: WorkspaceCaller) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.settings({
        ...storeCaller(caller),
        signal,
      }),
    );
  }
  @Route(routes.create)
  create(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() input: RouteInput<typeof routes.create>,
  ) {
    return this.command(request, caller, input, (scope) =>
      this.service.store.createOrganization({ ...scope, ...input.body }),
    );
  }
  @Route(routes.link)
  link(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() input: RouteInput<typeof routes.link>,
  ) {
    return this.command(request, caller, input, (scope) =>
      this.service.store.linkWorkspace({
        ...scope,
        targetWorkspaceId: input.body.workspaceId,
        defaultRole: input.body.defaultRole,
        expectedRevision: input.body.expectedRevision,
      }),
    );
  }
  @Route(routes.domain)
  domain(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() input: RouteInput<typeof routes.domain>,
  ) {
    return this.command(request, caller, input, (scope) =>
      this.service.store.createDomain({ ...scope, ...input.body }),
    );
  }
  @Route(routes.verify)
  verify(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() input: RouteInput<typeof routes.verify>,
  ) {
    return this.command(request, caller, input, (scope) =>
      this.service.verifyDomain({
        ...scope,
        ...input.body,
        domainId: input.params.domainId,
      }),
    );
  }
  @Route(routes.renew)
  renew(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() input: RouteInput<typeof routes.renew>,
  ) {
    return this.command(request, caller, input, (scope) =>
      this.service.store.renewDomainChallenge({
        ...scope,
        ...input.body,
        domainId: input.params.domainId,
      }),
    );
  }
  @Route(routes.removeDomain)
  removeDomain(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() input: RouteInput<typeof routes.removeDomain>,
  ) {
    return this.command(request, caller, input, (scope) =>
      this.service.store.removeDomain({
        ...scope,
        ...input.body,
        domainId: input.params.domainId,
      }),
    );
  }
  @Route(routes.enforce)
  enforce(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() input: RouteInput<typeof routes.enforce>,
  ) {
    return this.command(request, caller, input, (scope) =>
      this.service.store.configureEnforcement({
        ...scope,
        ...input.body,
        domainId: input.params.domainId,
      }),
    );
  }
  @Route(routes.provider)
  provider(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() input: RouteInput<typeof routes.provider>,
  ) {
    return this.command(request, caller, input, (scope) =>
      this.service.createProvider({ ...scope, ...input.body }),
    );
  }
  @Route(routes.updateProvider)
  updateProvider(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() input: RouteInput<typeof routes.updateProvider>,
  ) {
    return this.command(request, caller, input, (scope) =>
      this.service.updateProvider({
        ...scope,
        ...input.body,
        providerId: input.params.providerId,
      }),
    );
  }
  @Route(routes.metadata)
  metadata(@Req() request: Request, @Caller() caller: WorkspaceCaller) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.metadata({
        ...storeCaller(caller),
        signal,
      }),
    );
  }
  @Route(routes.removeProvider)
  removeProvider(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() input: RouteInput<typeof routes.removeProvider>,
  ) {
    return this.command(request, caller, input, (scope) =>
      this.service.store.removeProvider({
        ...scope,
        ...input.body,
        providerId: input.params.providerId,
      }),
    );
  }
}
