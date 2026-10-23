import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../workspaces/index.js';
import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';
import {
  requestIdempotencyKey,
  withRequestOperationSignal,
} from '../../platform/http/index.js';
import { singleRequestHeader } from '../../platform/http/request-headers.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import {
  WorkflowUpdateGuard,
  WorkflowPauseDefaultGuard,
} from '../http/guards.js';
import { throwWorkflowApplicationError } from '../../problems/authoring/workflows.js';
import type { WorkflowAuthoringRequest } from '../types.js';
import { WorkflowPromotionUseCase } from './use-case.js';

@Controller('v1/workspaces/:workspaceId/promotions')
@RateLimit('authenticated_read')
@UseGuards(SessionAuthenticationGuard, WorkflowUpdateGuard)
export class WorkflowPromotionController {
  constructor(private readonly controls: WorkflowPromotionUseCase) {}
  @Header('Cache-Control', 'private, no-store')
  @Get('settings')
  async settings(
    @Req() request: WorkflowAuthoringRequest,
    @Param('workspaceId') workspaceId: string,
  ) {
    try {
      return await withRequestOperationSignal(request, (signal) =>
        this.controls.settings({ ...context(request, workspaceId), signal }),
      );
    } catch (error) {
      return throwWorkflowApplicationError(error);
    }
  }
  @Header('Cache-Control', 'private, no-store')
  @Put('settings')
  @HttpCode(200)
  @RateLimit('ordinary_mutation')
  @UseGuards(WorkflowPauseDefaultGuard, CsrfProtectionGuard)
  async setTarget(
    @Req() request: WorkflowAuthoringRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    try {
      return await withRequestOperationSignal(request, (signal) =>
        this.controls.setTarget({
          ...context(request, workspaceId),
          request: body,
          idempotencyKey: requestIdempotencyKey(request.headers),
          signal,
        }),
      );
    } catch (error) {
      return throwWorkflowApplicationError(error);
    }
  }
  @Header('Cache-Control', 'private, no-store')
  @Get('candidates')
  async candidates(
    @Req() request: WorkflowAuthoringRequest,
    @Param('workspaceId') workspaceId: string,
    @Query() query: unknown,
  ) {
    try {
      return await withRequestOperationSignal(request, (signal) =>
        this.controls.candidates({
          ...context(request, workspaceId),
          request: query,
          signal,
        }),
      );
    } catch (error) {
      return throwWorkflowApplicationError(error);
    }
  }
  @Header('Cache-Control', 'private, no-store')
  @Get('history')
  async history(
    @Req() request: WorkflowAuthoringRequest,
    @Param('workspaceId') workspaceId: string,
    @Query() query: unknown,
  ) {
    try {
      return await withRequestOperationSignal(request, (signal) =>
        this.controls.history({
          ...context(request, workspaceId),
          request: query,
          signal,
        }),
      );
    } catch (error) {
      return throwWorkflowApplicationError(error);
    }
  }
  @Header('Cache-Control', 'private, no-store')
  @Post('preview')
  @HttpCode(200)
  @RateLimit('workflow_compile')
  @UseGuards(CsrfProtectionGuard)
  async preview(
    @Req() request: WorkflowAuthoringRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    try {
      return await withRequestOperationSignal(request, (signal) =>
        this.controls.preview({
          ...context(request, workspaceId),
          request: body,
          signal,
        }),
      );
    } catch (error) {
      return throwWorkflowApplicationError(error);
    }
  }
  @Header('Cache-Control', 'private, no-store')
  @Post('apply')
  @HttpCode(200)
  @RateLimit('workflow_compile')
  @UseGuards(CsrfProtectionGuard)
  async apply(
    @Req() request: WorkflowAuthoringRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    try {
      return await withRequestOperationSignal(request, (signal) =>
        this.controls.apply({
          ...context(request, workspaceId),
          request: body,
          idempotencyKey: requestIdempotencyKey(request.headers),
          signal,
        }),
      );
    } catch (error) {
      return throwWorkflowApplicationError(error);
    }
  }
}
function context(request: WorkflowAuthoringRequest, workspaceIdInput: string) {
  const workspaceId = z.uuid().parse(workspaceIdInput).toLowerCase();
  const traceparent = singleRequestHeader(request.headers, 'traceparent');
  return {
    ...projectAuthenticatedWorkspaceContext(request, workspaceId),
    routeWorkspaceId: workspaceId,
    ...(traceparent === undefined ? {} : { traceparent }),
  };
}
