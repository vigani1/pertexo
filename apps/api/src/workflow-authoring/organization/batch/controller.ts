import { requestIdempotencyKey } from '../../../platform/http/index.js';
import {
  Body,
  Controller,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { workflowTagWorkspaceParamsSchema } from '@pertexo/contracts';
import {
  SessionAuthenticationGuard,
  CsrfProtectionGuard,
} from '../../../workspaces/index.js';
import { RateLimit } from '../../../platform/rate-limit/metadata.js';
import { WorkflowParticipantGuard } from '../../http/guards.js';
import type { WorkflowAuthoringRequest } from '../../types.js';
import { WorkflowOrganizationBatchesUseCase } from './use-case.js';
import { withWorkflowOrganizationRequest } from '../http.js';
import { domainErrors } from '../../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../../problems/context/normalize.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller('v1/workspaces/:workspaceId')
@RateLimit('ordinary_mutation')
export class WorkflowOrganizationBatchesController {
  public constructor(
    private readonly batches: WorkflowOrganizationBatchesUseCase,
  ) {}

  @Post('workflows/organization/bulk')
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowParticipantGuard,
    CsrfProtectionGuard,
  )
  public bulk(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId } = workflowTagWorkspaceParamsSchema.parse(params);
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.batches.bulk({
        ...input,
        request: body,
        idempotencyKey: requestIdempotencyKey(request.headers),
      }),
    );
  }

  @Post('workflow-tags/cleanup/detach')
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowParticipantGuard,
    CsrfProtectionGuard,
  )
  public cleanup(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId } = workflowTagWorkspaceParamsSchema.parse(params);
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.batches.cleanup({
        ...input,
        request: body,
        idempotencyKey: requestIdempotencyKey(request.headers),
      }),
    );
  }
}
