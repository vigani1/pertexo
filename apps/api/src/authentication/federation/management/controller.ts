import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Param,
  Req,
  UseGuards,
  Header,
  HttpCode,
} from '@nestjs/common';
import {
  federationOrganizationCreateSchema,
  federationWorkspaceLinkSchema,
  federationDomainCreateSchema,
  federationRevisionCommandSchema,
  federationEnforcementSchema,
  oidcProviderCreateSchema,
  oidcProviderUpdateSchema,
  workspaceIdentifierSchema,
} from '@pertexo/contracts';
import {
  SessionAuthenticationGuard,
  CsrfProtectionGuard,
  WorkspaceManageGuard,
  authenticatedSession,
} from '../../../workspaces/index.js';
import type { IdentityWorkspaceRequest } from '../../../workspaces/types.js';
import {
  requestIdempotencyKey,
  withRequestOperationSignal,
} from '../../../platform/http/index.js';
import type { AbortableRequest } from '../../../platform/http/request-operation-signal.js';
import { RateLimit } from '../../../platform/rate-limit/metadata.js';
import { FederationManagementService } from './service.js';
type Request = IdentityWorkspaceRequest & AbortableRequest;
@Controller('v1/workspaces/:workspaceId/sso')
@UseGuards(SessionAuthenticationGuard, WorkspaceManageGuard)
@RateLimit('authenticated_read')
export class FederationManagementController {
  constructor(private readonly service: FederationManagementService) {}
  private scope(request: Request, workspace: unknown) {
    return {
      workspaceId: workspaceIdentifierSchema.parse(workspace),
      actorId: authenticatedSession(request).userId,
    };
  }
  private command<T>(
    request: Request,
    workspace: unknown,
    work: (
      scope: ReturnType<FederationManagementController['scope']> &
        Readonly<{ idempotencyKey: string; signal: AbortSignal }>,
    ) => Promise<T>,
  ) {
    const scope = this.scope(request, workspace),
      idempotencyKey = requestIdempotencyKey(request.headers);
    return withRequestOperationSignal(request, (signal) =>
      this.service.perform(() => {
        this.service.requireConfigured();
        return work({ ...scope, idempotencyKey, signal });
      }),
    );
  }
  @Get()
  @Header('Cache-Control', 'private, no-store')
  settings(@Req() request: Request, @Param('workspaceId') workspace: unknown) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.perform(() =>
        this.service.settings({ ...this.scope(request, workspace), signal }),
      ),
    );
  }
  @Post('organization')
  @HttpCode(200)
  @UseGuards(CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  create(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Body() raw: unknown,
  ) {
    const input = federationOrganizationCreateSchema.parse(raw);
    return this.command(request, workspace, (scope) =>
      this.service.store.createOrganization({ ...scope, ...input }),
    );
  }
  @Post('workspaces')
  @HttpCode(200)
  @UseGuards(CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  link(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Body() raw: unknown,
  ) {
    const input = federationWorkspaceLinkSchema.parse(raw);
    return this.command(request, workspace, (scope) =>
      this.service.store.linkWorkspace({
        ...scope,
        targetWorkspaceId: input.workspaceId,
        defaultRole: input.defaultRole,
        expectedRevision: input.expectedRevision,
      }),
    );
  }
  @Post('domains')
  @HttpCode(200)
  @UseGuards(CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  domain(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Body() raw: unknown,
  ) {
    const input = federationDomainCreateSchema.parse(raw);
    return this.command(request, workspace, (scope) =>
      this.service.store.createDomain({ ...scope, ...input }),
    );
  }
  @Post('domains/:domainId/verify')
  @HttpCode(200)
  @UseGuards(CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  verify(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Param('domainId') domain: unknown,
    @Body() raw: unknown,
  ) {
    const input = federationRevisionCommandSchema.parse(raw),
      domainId = workspaceIdentifierSchema.parse(domain);
    return this.command(request, workspace, (scope) =>
      this.service.verifyDomain({ ...scope, ...input, domainId }),
    );
  }
  @Post('domains/:domainId/renew')
  @HttpCode(200)
  @UseGuards(CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  renew(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Param('domainId') domain: unknown,
    @Body() raw: unknown,
  ) {
    const input = federationRevisionCommandSchema.parse(raw),
      domainId = workspaceIdentifierSchema.parse(domain);
    return this.command(request, workspace, (scope) =>
      this.service.store.renewDomainChallenge({ ...scope, ...input, domainId }),
    );
  }
  @Post('domains/:domainId/remove')
  @HttpCode(200)
  @UseGuards(CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  removeDomain(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Param('domainId') domain: unknown,
    @Body() raw: unknown,
  ) {
    const input = federationRevisionCommandSchema.parse(raw),
      domainId = workspaceIdentifierSchema.parse(domain);
    return this.command(request, workspace, (scope) =>
      this.service.store.removeDomain({ ...scope, ...input, domainId }),
    );
  }
  @Put('domains/:domainId/enforcement')
  @UseGuards(CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  enforce(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Param('domainId') domain: unknown,
    @Body() raw: unknown,
  ) {
    const input = federationEnforcementSchema.parse(raw),
      domainId = workspaceIdentifierSchema.parse(domain);
    return this.command(request, workspace, (scope) =>
      this.service.store.configureEnforcement({ ...scope, ...input, domainId }),
    );
  }
  @Post('providers')
  @HttpCode(200)
  @UseGuards(CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  provider(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Body() raw: unknown,
  ) {
    const input = oidcProviderCreateSchema.parse(raw);
    return this.command(request, workspace, (scope) =>
      this.service.createProvider({ ...scope, ...input }),
    );
  }
  @Put('providers/:providerId')
  @UseGuards(CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  updateProvider(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Param('providerId') provider: unknown,
    @Body() raw: unknown,
  ) {
    const input = oidcProviderUpdateSchema.parse(raw),
      providerId = workspaceIdentifierSchema.parse(provider);
    return this.command(request, workspace, (scope) =>
      this.service.updateProvider({ ...scope, ...input, providerId }),
    );
  }
  @Post('providers/:providerId/remove')
  @HttpCode(200)
  @UseGuards(CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  removeProvider(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Param('providerId') provider: unknown,
    @Body() raw: unknown,
  ) {
    const input = federationRevisionCommandSchema.parse(raw),
      providerId = workspaceIdentifierSchema.parse(provider);
    return this.command(request, workspace, (scope) =>
      this.service.store.removeOidcProvider({ ...scope, ...input, providerId }),
    );
  }
}
