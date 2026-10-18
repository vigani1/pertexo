import {
  Body,
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
  authenticatedSession,
} from '../../../../workspaces/index.js';
import type { IdentityWorkspaceRequest } from '../../../../workspaces/types.js';
import {
  requestIdempotencyKey,
  withRequestOperationSignal,
} from '../../../../platform/http/index.js';
import type { AbortableRequest } from '../../../../platform/http/request-operation-signal.js';
import { RateLimit } from '../../../../platform/rate-limit/metadata.js';
import { DirectoryManagementService } from './service.js';

type Request = IdentityWorkspaceRequest & AbortableRequest;
@Controller('v1/workspaces/:workspaceId/sso/directory')
@UseGuards(SessionAuthenticationGuard)
@RateLimit('authenticated_read')
export class DirectoryManagementController {
  constructor(private readonly service: DirectoryManagementService) {}
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
      scope: ReturnType<DirectoryManagementController['scope']> &
        Readonly<{ idempotencyKey: string; signal: AbortSignal }>,
    ) => Promise<T>,
  ) {
    const scope = this.scope(request, workspace),
      idempotencyKey = requestIdempotencyKey(request.headers);
    return withRequestOperationSignal(request, (signal) =>
      this.service.perform(() => work({ ...scope, idempotencyKey, signal })),
    );
  }
  @Header('Cache-Control', 'private, no-store')
  @Get()
  @UseGuards(WorkspaceMemberReadGuard)
  settings(@Req() request: Request, @Param('workspaceId') workspace: unknown) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.perform(() =>
        this.service.store.settings({
          ...this.scope(request, workspace),
          signal,
        }),
      ),
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
      this.service.perform(() =>
        this.service.store.people(
          { ...this.scope(request, workspace), signal },
          query,
        ),
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
    return this.command(request, workspace, (scope) =>
      this.service.store.createCredential({ ...scope, ...input }),
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
    return this.command(request, workspace, async (scope) => {
      await this.service.store.revokeCredential({
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
    return this.command(request, workspace, async (scope) => {
      await this.service.store.replaceMappings({ ...scope, ...input });
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
      this.service.perform(() =>
        this.service.store.adoption(
          { ...this.scope(request, workspace), signal },
          query,
        ),
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
    return this.command(request, workspace, async (scope) => {
      await this.service.store.adopt({ ...scope, ...input });
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
    return this.command(request, workspace, async (scope) => {
      await this.service.store.unlink({
        ...scope,
        ...input,
        targetWorkspaceId,
      });
      return { changed: true };
    });
  }
}
