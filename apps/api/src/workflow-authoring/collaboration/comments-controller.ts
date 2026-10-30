import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { workflowIdParamSchema } from '@pertexo/contracts';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../workspaces/index.js';
import { requestIdempotencyKey } from '../../platform/http/index.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import { WorkflowParticipantGuard, WorkflowReadGuard } from '../http/guards.js';
import type { WorkflowAuthoringRequest } from '../types.js';
import { WorkflowCollaborationUseCase } from './use-case.js';
import {
  collaborationOperation,
  discussionParamsSchema,
  commentParamsSchema,
} from './http.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { collaborationFailure } from '../../problems/context/normalize.js';

@UseInterceptors(domainErrors(collaborationFailure))
@Controller('v1/workspaces/:workspaceId/workflows/:workflowId/comments')
@RateLimit('authenticated_read')
@UseGuards(SessionAuthenticationGuard, WorkflowReadGuard)
export class WorkflowCommentsController {
  constructor(private readonly collaboration: WorkflowCollaborationUseCase) {}
  @Get('')
  @Header('Cache-Control', 'private, no-store')
  async list(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    return collaborationOperation(
      request,
      params,
      workflowIdParamSchema,
      (scope, route) => this.collaboration.list({ ...scope, ...route, query }),
    );
  }
  @Get('people')
  @Header('Cache-Control', 'private, no-store')
  async people(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    return collaborationOperation(
      request,
      params,
      workflowIdParamSchema,
      (scope, route) =>
        this.collaboration.people({ ...scope, ...route, query }),
    );
  }
  @Get(':threadId')
  @Header('Cache-Control', 'private, no-store')
  async read(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    return collaborationOperation(
      request,
      params,
      discussionParamsSchema,
      (scope, route) => this.collaboration.read({ ...scope, ...route, query }),
    );
  }
  @Post('')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WorkflowParticipantGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  @HttpCode(201)
  async create(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return collaborationOperation(
      request,
      params,
      workflowIdParamSchema,
      (scope, route) =>
        this.collaboration.create({
          ...scope,
          ...route,
          request: body,
          idempotencyKey: requestIdempotencyKey(request.headers),
        }),
    );
  }
  @Post(':threadId/replies')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WorkflowParticipantGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  @HttpCode(201)
  async reply(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return collaborationOperation(
      request,
      params,
      discussionParamsSchema,
      (scope, route) =>
        this.collaboration.reply({
          ...scope,
          ...route,
          request: body,
          idempotencyKey: requestIdempotencyKey(request.headers),
        }),
    );
  }
  @Put(':threadId/comments/:commentId')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WorkflowParticipantGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  async edit(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return collaborationOperation(
      request,
      params,
      commentParamsSchema,
      (scope, route) =>
        this.collaboration.edit({
          ...scope,
          ...route,
          request: body,
          idempotencyKey: requestIdempotencyKey(request.headers),
        }),
    );
  }
  @Delete(':threadId/comments/:commentId')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WorkflowParticipantGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  async remove(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return collaborationOperation(
      request,
      params,
      commentParamsSchema,
      (scope, route) =>
        this.collaboration.remove({
          ...scope,
          ...route,
          request: body,
          idempotencyKey: requestIdempotencyKey(request.headers),
        }),
    );
  }
  @Put(':threadId/status')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WorkflowParticipantGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  async setStatus(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return collaborationOperation(
      request,
      params,
      discussionParamsSchema,
      (scope, route) =>
        this.collaboration.setStatus({
          ...scope,
          ...route,
          request: body,
          idempotencyKey: requestIdempotencyKey(request.headers),
        }),
    );
  }
}
