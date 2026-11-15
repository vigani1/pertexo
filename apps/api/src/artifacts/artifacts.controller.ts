import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  artifactRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { In, Route, UnconfiguredRoute } from '../platform/http/route.js';
import {
  withRequestOperationSignal,
  applicationError,
  throwApplicationError,
} from '../platform/http/index.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';
import type { IdentityWorkspaceRequest } from '../workspaces/workspace-transport.js';
import { ArtifactService } from './artifact.service.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { artifactFailure } from '../problems/context/normalize-context-errors.js';
import {
  Caller,
  serviceCaller,
  type WorkspaceCaller,
} from '../workspaces/request/caller.js';

type ArtifactRequest = IdentityWorkspaceRequest & AbortableRequest;

@UseInterceptors(domainErrors(artifactFailure))
@Controller()
export class ArtifactsController {
  public constructor(private readonly artifacts: ArtifactService) {}

  @Route(routes.beginUpload)
  public beginUpload(
    @Req() request: ArtifactRequest,
    @Caller() caller: WorkspaceCaller,
    @In()
    { body, idempotencyKey }: RouteInput<typeof routes.beginUpload>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.artifacts.beginUpload({
        ...serviceCaller(caller),
        idempotencyKey,
        request: body,
        signal,
      }),
    );
  }

  @Route(routes.finalizeUpload)
  public finalizeUpload(
    @Req() request: ArtifactRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.finalizeUpload>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.artifacts.finalizeUpload({
        ...serviceCaller(caller),
        artifactId: params.artifactId,
        signal,
      }),
    );
  }

  @Route(routes.metadata)
  public getMetadata(
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.metadata>,
  ) {
    return this.artifacts.getMetadata({
      ...serviceCaller(caller),
      artifactId: params.artifactId,
    });
  }

  @Route(routes.beginDownload)
  public beginDownload(
    @Req() request: ArtifactRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.beginDownload>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.artifacts.beginDownload({
        ...serviceCaller(caller),
        artifactId: params.artifactId,
        signal,
      }),
    );
  }
}

/** The same routes when no store is configured: each says why it can't work. */
@UseInterceptors(domainErrors(artifactFailure))
@Controller()
export class UnconfiguredArtifactsController {
  @UnconfiguredRoute(routes.beginUpload)
  public beginUpload(): never {
    return unavailableStorage();
  }

  @UnconfiguredRoute(routes.finalizeUpload)
  public finalizeUpload(): never {
    return unavailableStorage();
  }

  @UnconfiguredRoute(routes.metadata)
  public getMetadata(): never {
    return unavailableStorage();
  }

  @UnconfiguredRoute(routes.beginDownload)
  public beginDownload(): never {
    return unavailableStorage();
  }
}

function unavailableStorage(): never {
  return throwApplicationError(
    applicationError('artifact.unavailable', {
      safeDetail:
        'File storage is disabled on this server. Configure ARTIFACT_STORE_* to enable uploads and downloads.',
    }),
  );
}
