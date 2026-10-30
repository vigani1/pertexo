import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
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
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import { WorkflowParticipantGuard, WorkflowReadGuard } from '../http/guards.js';
import type { WorkflowAuthoringRequest } from '../types.js';
import { WorkflowCollaborationUseCase } from './use-case.js';
import { collaborationOperation, presenceParamsSchema } from './http.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { collaborationFailure } from '../../problems/context/normalize.js';

@UseInterceptors(domainErrors(collaborationFailure))
@Controller('v1/workspaces/:workspaceId/workflows/:workflowId/presence')
@RateLimit('authenticated_read')
@UseGuards(SessionAuthenticationGuard, WorkflowReadGuard)
export class WorkflowPresenceController {
  constructor(private readonly collaboration: WorkflowCollaborationUseCase) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  async read(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    return collaborationOperation(
      request,
      params,
      workflowIdParamSchema,
      (scope, route) =>
        this.collaboration.presence({ ...scope, ...route, query }),
    );
  }
  @Put(':tabId')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @UseGuards(WorkflowParticipantGuard, CsrfProtectionGuard)
  async heartbeat(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return collaborationOperation(
      request,
      params,
      presenceParamsSchema,
      (scope, route) =>
        this.collaboration.heartbeat({ ...scope, ...route, request: body }),
    );
  }
  @Delete(':tabId')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(204)
  @UseGuards(WorkflowParticipantGuard, CsrfProtectionGuard)
  async leave(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
  ) {
    return collaborationOperation(
      request,
      params,
      presenceParamsSchema,
      (scope, route) => this.collaboration.leave({ ...scope, ...route }),
    );
  }
}
