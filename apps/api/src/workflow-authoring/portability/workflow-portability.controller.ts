import { Body, Controller, Req, Res, UseInterceptors } from '@nestjs/common';
import {
  portabilityRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { requestHeaderValue } from '../../platform/http/request-headers.js';
import { withRequestOperationSignal } from '../../platform/http/request-operation-signal.js';
import { authoringFailure } from '../../problems/context/normalize-context-errors.js';
import { In, Route } from '../../platform/http/route.js';
import type {
  WorkflowAuthoringRequest,
  WorkflowResponse,
} from '../workflow-authoring-request.js';
import {
  ExportWorkflowService,
  ImportWorkflowService,
  PreviewWorkflowImportService,
} from './workflow-portability.service.js';
import {
  Caller,
  serviceCaller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowPortabilityController {
  public constructor(
    private readonly exportWorkflow: ExportWorkflowService,
    private readonly previewImport: PreviewWorkflowImportService,
    private readonly importWorkflow: ImportWorkflowService,
  ) {}

  // Nest binds handler arguments by decorator position, so they stay separate.
  // eslint-disable-next-line max-params
  @Route(routes.export)
  public async export(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.export>,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const route = params;
    const result = await withRequestOperationSignal(request, (signal) =>
      this.exportWorkflow.execute({
        ...serviceCaller(caller),
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
    @Caller() caller: WorkspaceCaller,
    @Body() body: unknown,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.previewImport.execute({
        ...serviceCaller(caller),
        request: body,
        signal,
      }),
    );
  }

  // Nest binds handler arguments by decorator position, so they stay separate.
  // eslint-disable-next-line max-params
  @Route(routes.import)
  public async import(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, idempotencyKey }: RouteInput<typeof routes.import>,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const { workspaceId } = params;
    const result = await withRequestOperationSignal(request, (signal) =>
      this.importWorkflow.execute({
        ...serviceCaller(caller),
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
