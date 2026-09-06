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
} from '@pertexo/contracts/artifacts';
import { idempotencyKeySchema } from '@pertexo/contracts/identity-workspace';

import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  authenticatedSession,
  requestIdentifier,
  traceIdentifier,
} from '../identity-workspace/index.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { withRequestOperationSignal } from '../platform/http/index.js';
import { singleRequestHeader } from '../platform/http/request-headers.js';
import { createActorContext } from '../workspaces/index.js';
import type { IdentityWorkspaceRequest } from '../identity-workspace/types.js';
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
        idempotencyKey: idempotencyKey(request),
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
  if (request.authorizedWorkspace !== undefined)
    return request.authorizedWorkspace.actor;
  const session = authenticatedSession(request);
  return createActorContext({
    actorId: session.userId,
    workspaceId,
    sessionId: session.sessionId,
    requestId: requestIdentifier(request),
    ...traceInput(request),
  });
}

function idempotencyKey(request: ArtifactRequest): string {
  return idempotencyKeySchema.parse(
    singleRequestHeader(request.headers, 'idempotency-key'),
  );
}

function authorizedInput(request: ArtifactRequest): Readonly<{
  authorizedWorkspace?: NonNullable<ArtifactRequest['authorizedWorkspace']>;
}> {
  return request.authorizedWorkspace === undefined
    ? {}
    : { authorizedWorkspace: request.authorizedWorkspace };
}

function traceInput(request: ArtifactRequest): Readonly<{ traceId?: string }> {
  const traceId = traceIdentifier(request);
  return traceId === undefined ? {} : { traceId };
}
