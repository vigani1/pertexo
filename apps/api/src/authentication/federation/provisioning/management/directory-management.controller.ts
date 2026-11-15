import { Controller, Inject, Req, UseInterceptors } from '@nestjs/common';
import {
  directoryRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import type { DirectoryStore } from '@pertexo/core/identity';
import { withRequestOperationSignal } from '../../../../platform/http/index.js';
import { domainErrors } from '../../../../platform/http/problems/interceptor.js';
import { resourceFailure } from '../../../../problems/context/normalize-context-errors.js';
import { In, Route } from '../../../../platform/http/route.js';
import {
  federationCommand,
  type FederationManagementRequest,
} from '../../management/federation-request.js';
import { DIRECTORY_STORE } from './tokens.js';
import {
  Caller,
  storeCaller,
  type WorkspaceCaller,
} from '../../../../workspaces/request/caller.js';

type Request = FederationManagementRequest;
@UseInterceptors(domainErrors(resourceFailure))
@Controller()
export class DirectoryManagementController {
  constructor(
    @Inject(DIRECTORY_STORE) private readonly service: DirectoryStore,
  ) {}
  @Route(routes.settings)
  settings(@Req() request: Request, @Caller() caller: WorkspaceCaller) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.settings({
        ...storeCaller(caller),
        signal,
      }),
    );
  }
  @Route(routes.people)
  people(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { query }: RouteInput<typeof routes.people>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.people(
        {
          ...storeCaller(caller),
          signal,
        },
        query,
      ),
    );
  }
  @Route(routes.createCredential)
  createCredential(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In()
    { body, idempotencyKey }: RouteInput<typeof routes.createCredential>,
  ) {
    const input = body;
    return federationCommand(
      request,
      caller,
      {
        idempotencyKey: idempotencyKey,
      },
      (scope) => this.service.createCredential({ ...scope, ...input }),
    );
  }
  @Route(routes.revokeCredential)
  revokeCredential(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In()
    {
      params,
      body,
      idempotencyKey,
    }: RouteInput<typeof routes.revokeCredential>,
  ) {
    const input = body,
      credentialId = params.credentialId;
    return federationCommand(
      request,
      caller,
      {
        idempotencyKey: idempotencyKey,
      },
      async (scope) => {
        await this.service.revokeCredential({
          ...scope,
          ...input,
          credentialId,
        });
        return { changed: true };
      },
    );
  }
  @Route(routes.mappings)
  mappings(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { body, idempotencyKey }: RouteInput<typeof routes.mappings>,
  ) {
    const input = body;
    return federationCommand(
      request,
      caller,
      {
        idempotencyKey: idempotencyKey,
      },
      async (scope) => {
        await this.service.replaceMappings({ ...scope, ...input });
        return { changed: true };
      },
    );
  }
  @Route(routes.adoption)
  adoption(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { query }: RouteInput<typeof routes.adoption>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.adoption(
        {
          ...storeCaller(caller),
          signal,
        },
        query,
      ),
    );
  }
  @Route(routes.adopt)
  adopt(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { body, idempotencyKey }: RouteInput<typeof routes.adopt>,
  ) {
    const input = body;
    return federationCommand(
      request,
      caller,
      {
        idempotencyKey: idempotencyKey,
      },
      async (scope) => {
        await this.service.adopt({ ...scope, ...input });
        return { changed: true };
      },
    );
  }
  @Route(routes.unlink)
  unlink(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.unlink>,
  ) {
    const input = body,
      targetWorkspaceId = params.targetWorkspaceId;
    return federationCommand(
      request,
      caller,
      {
        idempotencyKey: idempotencyKey,
      },
      async (scope) => {
        await this.service.unlink({
          ...scope,
          ...input,
          targetWorkspaceId,
        });
        return { changed: true };
      },
    );
  }
}
