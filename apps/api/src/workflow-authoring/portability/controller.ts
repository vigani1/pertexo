import { requestIdempotencyKey } from '../../platform/http/index.js';
import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../workspaces/index.js';
import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';
import { withRequestOperationSignal } from '../../platform/http/request-operation-signal.js';
import { requestHeaderValue } from '../../platform/http/request-headers.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import { WorkflowCreateGuard, WorkflowReadGuard } from '../http/guards.js';
import {
  ExportWorkflowUseCase,
  ImportWorkflowUseCase,
  PreviewWorkflowImportUseCase,
} from './use-cases.js';
import {
  workflowIdParamSchema,
  type WorkflowAuthoringRequest,
  type WorkflowResponse,
} from '../types.js';

const workspaceParams = workflowIdParamSchema
  .pick({ workspaceId: true })
  .strict();

@Controller('v1/workspaces/:workspaceId/workflows')
export class WorkflowPortabilityController {
  public constructor(
    private readonly exportWorkflow: ExportWorkflowUseCase,
    private readonly previewImport: PreviewWorkflowImportUseCase,
    private readonly importWorkflow: ImportWorkflowUseCase,
  ) {}

  @Post(':workflowId/export')
  @HttpCode(200)
  @RateLimit('workflow_compile')
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard, CsrfProtectionGuard)
  public async export(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const route = workflowIdParamSchema.parse(params);
    privateResponse(response);
    const result = await withRequestOperationSignal(request, (signal) =>
      this.exportWorkflow.execute({
        ...projectAuthenticatedWorkspaceContext(request, route.workspaceId),
        routeWorkspaceId: route.workspaceId,
        workflowId: route.workflowId,
        request: body,
        ...(requestHeaderValue(request.headers, 'if-match') === undefined
          ? {}
          : {
              representationTag: requestHeaderValue(
                request.headers,
                'if-match',
              ),
            }),
        signal,
      }),
    );
    response.header(
      'Content-Disposition',
      'attachment; filename="workflow.pertexo.json"',
    );
    response.header('Content-Type', 'application/json');
    return result;
  }

  @Post('import/preview')
  @HttpCode(200)
  @RateLimit('workflow_compile')
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowCreateGuard,
    CsrfProtectionGuard,
  )
  public preview(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const { workspaceId } = workspaceParams.parse(params);
    privateResponse(response);
    return withRequestOperationSignal(request, (signal) =>
      this.previewImport.execute({
        ...projectAuthenticatedWorkspaceContext(request, workspaceId),
        routeWorkspaceId: workspaceId,
        request: body,
        signal,
      }),
    );
  }

  @Post('import')
  @HttpCode(201)
  @RateLimit('workflow_compile')
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowCreateGuard,
    CsrfProtectionGuard,
  )
  public async import(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const { workspaceId } = workspaceParams.parse(params);
    privateResponse(response);
    const result = await withRequestOperationSignal(request, (signal) =>
      this.importWorkflow.execute({
        ...projectAuthenticatedWorkspaceContext(request, workspaceId),
        routeWorkspaceId: workspaceId,
        request: body,
        idempotencyKey: requestIdempotencyKey(request.headers),
        signal,
      }),
    );
    response.header(
      'Location',
      `/v1/workspaces/${workspaceId}/workflows/${result.workflowId}`,
    );
    return result;
  }
}
function privateResponse(response: WorkflowResponse): void {
  response.header('Cache-Control', 'private, no-store');
}
