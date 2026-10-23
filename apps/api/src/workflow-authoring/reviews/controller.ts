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
  UseInterceptors,
} from '@nestjs/common';
import {
  publicationReviewParamsSchema,
  workflowIdParamSchema,
} from '@pertexo/contracts';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../workspaces/index.js';
import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';
import {
  requestIdempotencyKey,
  withRequestOperationSignal,
} from '../../platform/http/index.js';
import {
  requestHeaderValue,
  singleRequestHeader,
} from '../../platform/http/request-headers.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import {
  WorkflowReadGuard,
  WorkflowPublishGuard,
  WorkflowReviewGuard,
} from '../http/guards.js';
import { parseStrongIfMatch } from '../http/preconditions.js';

import type { WorkflowAuthoringRequest } from '../types.js';
import { PublicationReviewUseCase } from './use-case.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller(
  'v1/workspaces/:workspaceId/workflows/:workflowId/publication-review',
)
@RateLimit('authenticated_read')
export class WorkflowPublicationReviewController {
  constructor(private readonly controls: PublicationReviewUseCase) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard)
  async overview(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
  ) {
    const route = workflowIdParamSchema.parse(params);
    return await withRequestOperationSignal(request, (signal) =>
      this.controls.overview({
        ...context(request, route.workspaceId),
        workflowId: route.workflowId,
        signal,
      }),
    );
  }
  @Post()
  @HttpCode(201)
  @RateLimit('workflow_compile')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowPublishGuard,
    CsrfProtectionGuard,
  )
  async create(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = workflowIdParamSchema.parse(params);
    return await withRequestOperationSignal(request, (signal) =>
      this.controls.request({
        ...context(request, route.workspaceId),
        workflowId: route.workflowId,
        request: body,
        representationTag: parseStrongIfMatch(
          requestHeaderValue(request.headers, 'if-match'),
        ),
        idempotencyKey: requestIdempotencyKey(request.headers),
        signal,
      }),
    );
  }
}
@UseInterceptors(domainErrors(authoringFailure))
@Controller('v1/workspaces/:workspaceId/publication-requests/:requestId')
@RateLimit('authenticated_read')
export class PublicationReviewController {
  constructor(private readonly controls: PublicationReviewUseCase) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard)
  async read(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
  ) {
    const route = publicationReviewParamsSchema.parse(params);
    return await withRequestOperationSignal(request, (signal) =>
      this.controls.read({
        ...context(request, route.workspaceId),
        reviewId: route.requestId,
        signal,
      }),
    );
  }
  @Post('decision')
  @HttpCode(200)
  @RateLimit('workflow_compile')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowReviewGuard,
    CsrfProtectionGuard,
  )
  async decide(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = publicationReviewParamsSchema.parse(params);
    return await withRequestOperationSignal(request, (signal) =>
      this.controls.decide({
        ...context(request, route.workspaceId),
        reviewId: route.requestId,
        request: body,
        idempotencyKey: requestIdempotencyKey(request.headers),
        signal,
      }),
    );
  }
}
function context(request: WorkflowAuthoringRequest, workspaceId: string) {
  const traceparent = singleRequestHeader(request.headers, 'traceparent');
  return {
    ...projectAuthenticatedWorkspaceContext(request, workspaceId),
    routeWorkspaceId: workspaceId,
    ...(traceparent === undefined ? {} : { traceparent }),
  };
}
