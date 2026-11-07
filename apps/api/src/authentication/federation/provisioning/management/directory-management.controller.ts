import { Controller, Inject, Req, UseInterceptors } from '@nestjs/common';
import {
  directoryRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import type { DirectoryStore } from '@pertexo/core/identity';
import { withRequestOperationSignal } from '../../../../platform/http/index.js';
import { domainErrors } from '../../../../platform/http/problems/interceptor.js';
import { resourceFailure } from '../../../../problems/context/normalize-context-errors.js';
import { In, Route } from '../../../../workspaces/http/route.js';
import {
  federationCommand,
  federationScope,
  type FederationManagementRequest,
} from '../../management/federation-request.js';
import { DIRECTORY_STORE } from './tokens.js';

type Request = FederationManagementRequest;
@UseInterceptors(domainErrors(resourceFailure))
@Controller()
export class DirectoryManagementController {
  constructor(
    @Inject(DIRECTORY_STORE) private readonly service: DirectoryStore,
  ) {}
  @Route(routes.settings)
  settings(
    @Req() request: Request,
    @In() { params }: RouteInput<typeof routes.settings>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.settings({
        ...federationScope(request, params.workspaceId),
        signal,
      }),
    );
  }
  @Route(routes.people)
  people(
    @Req() request: Request,
    @In() { params, query }: RouteInput<typeof routes.people>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.people(
        {
          ...federationScope(request, params.workspaceId),
          signal,
        },
        query,
      ),
    );
  }
  @Route(routes.createCredential)
  createCredential(
    @Req() request: Request,
    @In()
    {
      params,
      body,
      idempotencyKey,
    }: RouteInput<typeof routes.createCredential>,
  ) {
    const input = body;
    return federationCommand(
      request,
      {
        workspaceId: params.workspaceId,
        idempotencyKey: idempotencyKey,
      },
      (scope) => this.service.createCredential({ ...scope, ...input }),
    );
  }
  @Route(routes.revokeCredential)
  revokeCredential(
    @Req() request: Request,
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
      {
        workspaceId: params.workspaceId,
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
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.mappings>,
  ) {
    const input = body;
    return federationCommand(
      request,
      {
        workspaceId: params.workspaceId,
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
    @In() { params, query }: RouteInput<typeof routes.adoption>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.adoption(
        {
          ...federationScope(request, params.workspaceId),
          signal,
        },
        query,
      ),
    );
  }
  @Route(routes.adopt)
  adopt(
    @Req() request: Request,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.adopt>,
  ) {
    const input = body;
    return federationCommand(
      request,
      {
        workspaceId: params.workspaceId,
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
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.unlink>,
  ) {
    const input = body,
      targetWorkspaceId = params.targetWorkspaceId;
    return federationCommand(
      request,
      {
        workspaceId: params.workspaceId,
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
