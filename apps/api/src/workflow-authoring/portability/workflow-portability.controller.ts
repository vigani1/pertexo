import { Body, Controller, Req, Res, UseInterceptors } from '@nestjs/common';
import {
  portabilityRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { requestHeaderValue } from '../../platform/http/request-headers.js';
import { withRequestOperationSignal } from '../../platform/http/request-operation-signal.js';
import { authoringFailure } from '../../problems/context/normalize.js';
import { In, Route } from '../../workspaces/http/route.js';
import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';
import type {
  WorkflowAuthoringRequest,
  WorkflowResponse,
} from '../workflow-transport.js';
import {
  ExportWorkflowUseCase,
  ImportWorkflowUseCase,
  PreviewWorkflowImportUseCase,
} from './workflow-portability.service.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowPortabilityController {
  public constructor(
    private readonly exportWorkflow: ExportWorkflowUseCase,
    private readonly previewImport: PreviewWorkflowImportUseCase,
    private readonly importWorkflow: ImportWorkflowUseCase,
  ) {}

  @Route(routes.export)
  public async export(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params }: RouteInput<typeof routes.export>,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const route = params;
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

  @Route(routes.preview)
  public preview(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params }: RouteInput<typeof routes.preview>,
    @Body() body: unknown,
  ) {
    const { workspaceId } = params;
    return withRequestOperationSignal(request, (signal) =>
      this.previewImport.execute({
        ...projectAuthenticatedWorkspaceContext(request, workspaceId),
        routeWorkspaceId: workspaceId,
        request: body,
        signal,
      }),
    );
  }

  @Route(routes.import)
  public async import(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, idempotencyKey }: RouteInput<typeof routes.import>,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const { workspaceId } = params;
    const result = await withRequestOperationSignal(request, (signal) =>
      this.importWorkflow.execute({
        ...projectAuthenticatedWorkspaceContext(request, workspaceId),
        routeWorkspaceId: workspaceId,
        request: body,
        idempotencyKey: idempotencyKey,
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
