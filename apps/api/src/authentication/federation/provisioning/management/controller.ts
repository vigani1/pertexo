import {
  federationScope,
  federationCommand,
  type FederationManagementRequest,
} from '../../management/request.js';
import {
  Body,
  Inject,
  Controller,
  Get,
  Post,
  Put,
  Param,
  Query,
  Req,
  UseGuards,
  Header,
  HttpCode,
  UseInterceptors,
} from '@nestjs/common';
import {
  directoryAdoptionQuerySchema,
  directoryCredentialCreateSchema,
  directoryRevisionSchema,
  directoryMappingsSchema,
  directoryAdoptSchema,
  directoryPeopleQuerySchema,
  workspaceIdentifierSchema,
} from '@pertexo/contracts';
import {
  SessionAuthenticationGuard,
  CsrfProtectionGuard,
  WorkspaceManageGuard,
  WorkspaceMemberReadGuard,
} from '../../../../workspaces/index.js';
import { withRequestOperationSignal } from '../../../../platform/http/index.js';
import { RateLimit } from '../../../../platform/rate-limit/metadata.js';
import type { DirectoryStore } from '@pertexo/core/tenant-access';
import { DIRECTORY_STORE } from './tokens.js';
import { domainErrors } from '../../../../platform/http/problems/interceptor.js';
import { resourceFailure } from '../../../../problems/context/normalize.js';

type Request = FederationManagementRequest;
@UseInterceptors(domainErrors(resourceFailure))
@Controller('v1/workspaces/:workspaceId/sso/directory')
@UseGuards(SessionAuthenticationGuard)
@RateLimit('authenticated_read')
export class DirectoryManagementController {
  constructor(
    @Inject(DIRECTORY_STORE) private readonly service: DirectoryStore,
  ) {}
  @Header('Cache-Control', 'private, no-store')
  @Get()
  @UseGuards(WorkspaceMemberReadGuard)
  settings(@Req() request: Request, @Param('workspaceId') workspace: unknown) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.settings({
        ...federationScope(request, workspace),
        signal,
      }),
    );
  }
  @Header('Cache-Control', 'private, no-store')
  @Get('people')
  @UseGuards(WorkspaceMemberReadGuard)
  people(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Query() raw: unknown,
  ) {
    const query = directoryPeopleQuerySchema.parse(raw);
    return withRequestOperationSignal(request, (signal) =>
      this.service.people(
        { ...federationScope(request, workspace), signal },
        query,
      ),
    );
  }
  @Header('Cache-Control', 'private, no-store')
  @Post('credentials')
  @HttpCode(200)
  @UseGuards(WorkspaceManageGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  createCredential(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Body() raw: unknown,
  ) {
    const input = directoryCredentialCreateSchema.parse(raw);
    return federationCommand(request, workspace, (scope) =>
      this.service.createCredential({ ...scope, ...input }),
    );
  }
  @Header('Cache-Control', 'private, no-store')
  @Post('credentials/:credentialId/revoke')
  @HttpCode(200)
  @UseGuards(WorkspaceManageGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  revokeCredential(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Param('credentialId') rawId: unknown,
    @Body() raw: unknown,
  ) {
    const input = directoryRevisionSchema.parse(raw),
      credentialId = workspaceIdentifierSchema.parse(rawId);
    return federationCommand(request, workspace, async (scope) => {
      await this.service.revokeCredential({
        ...scope,
        ...input,
        credentialId,
      });
      return { changed: true };
    });
  }
  @Header('Cache-Control', 'private, no-store')
  @Put('mappings')
  @UseGuards(WorkspaceManageGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  mappings(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Body() raw: unknown,
  ) {
    const input = directoryMappingsSchema.parse(raw);
    return federationCommand(request, workspace, async (scope) => {
      await this.service.replaceMappings({ ...scope, ...input });
      return { changed: true };
    });
  }
  @Header('Cache-Control', 'private, no-store')
  @Get('adoption')
  @UseGuards(WorkspaceManageGuard)
  adoption(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Query() raw: unknown,
  ) {
    const query = directoryAdoptionQuerySchema.parse(raw);
    return withRequestOperationSignal(request, (signal) =>
      this.service.adoption(
        { ...federationScope(request, workspace), signal },
        query,
      ),
    );
  }
  @Header('Cache-Control', 'private, no-store')
  @Post('adopt')
  @HttpCode(200)
  @UseGuards(WorkspaceManageGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  adopt(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Body() raw: unknown,
  ) {
    const input = directoryAdoptSchema.parse(raw);
    return federationCommand(request, workspace, async (scope) => {
      await this.service.adopt({ ...scope, ...input });
      return { changed: true };
    });
  }
  @Header('Cache-Control', 'private, no-store')
  @Post('workspaces/:targetWorkspaceId/unlink')
  @HttpCode(200)
  @UseGuards(WorkspaceManageGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  unlink(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Param('targetWorkspaceId') rawId: unknown,
    @Body() raw: unknown,
  ) {
    const input = directoryRevisionSchema.parse(raw),
      targetWorkspaceId = workspaceIdentifierSchema.parse(rawId);
    return federationCommand(request, workspace, async (scope) => {
      await this.service.unlink({
        ...scope,
        ...input,
        targetWorkspaceId,
      });
      return { changed: true };
    });
  }
}
