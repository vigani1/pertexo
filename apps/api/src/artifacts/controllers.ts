import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  artifactParamsSchema,
  artifactWorkspaceParamsSchema,
} from '@pertexo/contracts';

import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../workspaces/index.js';
import {
  optionalAuthorizedWorkspace,
  projectAuthenticatedWorkspaceContext,
} from '../workspaces/request/authenticated-context.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import {
  requestIdempotencyKey,
  withRequestOperationSignal,
} from '../platform/http/index.js';
import type { IdentityWorkspaceRequest } from '../workspaces/types.js';
import { ArtifactReadGuard, ArtifactUploadGuard } from './guards.js';
import { ArtifactService } from './service.js';

type ArtifactRequest = IdentityWorkspaceRequest & {
  raw?: Readonly<{
    destroyed?: boolean;
    once(event: 'aborted', listener: () => void): unknown;
    off(event: 'aborted', listener: () => void): unknown;
    socket?: Readonly<{
      destroyed?: boolean;
      once(event: 'close', listener: () => void): unknown;
      off(event: 'close', listener: () => void): unknown;
    }>;
  }>;
};

@Controller('v1/workspaces/:workspaceId/artifacts')
@RateLimit('ordinary_mutation')
export class ArtifactsController {
  public constructor(private readonly artifacts: ArtifactService) {}

  @Post('uploads')
  @HttpCode(201)
  @RateLimit('ordinary_mutation')
  @UseGuards(
    SessionAuthenticationGuard,
    ArtifactUploadGuard,
    CsrfProtectionGuard,
  )
  @Header('Cache-Control', 'no-store')
  public beginUpload(
    @Req() request: ArtifactRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = artifactWorkspaceParamsSchema.parse(params);
    return withRequestOperationSignal(request, (signal) =>
      this.artifacts.beginUpload({
        actor: actorFrom(request, route.workspaceId),
        ...authorizedInput(request),
        idempotencyKey: requestIdempotencyKey(request.headers),
        request: body,
        routeWorkspaceId: route.workspaceId,
        signal,
      }),
    );
  }

  @Post(':artifactId/finalize')
  @HttpCode(200)
  @RateLimit('ordinary_mutation')
  @UseGuards(
    SessionAuthenticationGuard,
    ArtifactUploadGuard,
    CsrfProtectionGuard,
  )
  @Header('Cache-Control', 'no-store')
  public finalizeUpload(
    @Req() request: ArtifactRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = artifactParamsSchema.parse(params);
    return withRequestOperationSignal(request, (signal) =>
      this.artifacts.finalizeUpload({
        actor: actorFrom(request, route.workspaceId),
        ...authorizedInput(request),
        artifactId: route.artifactId,
        request: body,
        routeWorkspaceId: route.workspaceId,
        signal,
      }),
    );
  }

  @Get(':artifactId')
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard, ArtifactReadGuard)
  @Header('Cache-Control', 'no-store')
  public getMetadata(
    @Req() request: ArtifactRequest,
    @Param() params: unknown,
  ) {
    const route = artifactParamsSchema.parse(params);
    return this.artifacts.getMetadata({
      actor: actorFrom(request, route.workspaceId),
      ...authorizedInput(request),
      artifactId: route.artifactId,
      routeWorkspaceId: route.workspaceId,
    });
  }

  @Get(':artifactId/download')
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard, ArtifactReadGuard)
  @Header('Cache-Control', 'no-store')
  public beginDownload(
    @Req() request: ArtifactRequest,
    @Param() params: unknown,
  ) {
    const route = artifactParamsSchema.parse(params);
    return withRequestOperationSignal(request, (signal) =>
      this.artifacts.beginDownload({
        actor: actorFrom(request, route.workspaceId),
        ...authorizedInput(request),
        artifactId: route.artifactId,
        routeWorkspaceId: route.workspaceId,
        signal,
      }),
    );
  }
}

function actorFrom(request: ArtifactRequest, workspaceId: string) {
  return projectAuthenticatedWorkspaceContext(request, workspaceId).actor;
}

function authorizedInput(request: ArtifactRequest): Readonly<{
  authorizedWorkspace?: NonNullable<ArtifactRequest['authorizedWorkspace']>;
}> {
  return optionalAuthorizedWorkspace(request);
}
