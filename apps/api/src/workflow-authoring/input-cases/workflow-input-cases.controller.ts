import { Controller, Req, Res, UseInterceptors } from '@nestjs/common';
import { parseWorkflowInputCaseTag } from '@pertexo/contracts';
import {
  inputCaseRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../../platform/http/route.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import { requestHeaderValue } from '../../platform/http/request-headers.js';
import { WorkflowHeaderError } from '../http/preconditions.js';
import type { WorkflowAuthoringRequest } from '../workflow-authoring-request.js';
import { WorkflowInputCasesService } from './workflow-input-cases.service.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { inputCaseFailure } from '../../problems/context/normalize-context-errors.js';
import {
  Caller,
  serviceCaller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

type Request = WorkflowAuthoringRequest & AbortableRequest;

@UseInterceptors(domainErrors(inputCaseFailure))
@Controller()
export class WorkflowInputCasesController {
  public constructor(private readonly cases: WorkflowInputCasesService) {}

  @Route(routes.list)
  public async list(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params, query }: RouteInput<typeof routes.list>,
  ) {
    return await withRequestOperationSignal(request, (signal) =>
      this.cases.list({
        ...serviceCaller(caller),
        workflowId: params.workflowId,
        query,
        signal,
      }),
    );
  }

  /** The answer's tag is the `If-Match` a later change must send. */
  @Route(routes.get)
  public async get(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.get>,
    @Res({ passthrough: true })
    response: Readonly<{ header(name: string, value: string): unknown }>,
  ) {
    const result = await withRequestOperationSignal(request, (signal) =>
      this.cases.get({
        ...serviceCaller(caller),
        workflowId: params.workflowId,
        caseId: params.caseId,
        signal,
      }),
    );
    response.header('ETag', result.case.representationTag);
    return result;
  }

  @Route(routes.create)
  public async create(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.create>,
  ) {
    return await withRequestOperationSignal(request, (signal) =>
      this.cases.create({
        ...serviceCaller(caller),
        workflowId: params.workflowId,
        request: body,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Route(routes.update)
  public async update(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.update>,
  ) {
    const representationTag = parseCaseIfMatch(
      requestHeaderValue(request.headers, 'if-match'),
    );
    return await withRequestOperationSignal(request, (signal) =>
      this.cases.update({
        ...serviceCaller(caller),
        workflowId: params.workflowId,
        caseId: params.caseId,
        request: body,
        representationTag,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Route(routes.delete)
  public async delete(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params, idempotencyKey }: RouteInput<typeof routes.delete>,
  ) {
    const representationTag = parseCaseIfMatch(
      requestHeaderValue(request.headers, 'if-match'),
    );
    return await withRequestOperationSignal(request, (signal) =>
      this.cases.delete({
        ...serviceCaller(caller),
        workflowId: params.workflowId,
        caseId: params.caseId,
        representationTag,
        idempotencyKey,
        signal,
      }),
    );
  }
}

export function parseCaseIfMatch(value: unknown): string {
  if (value === undefined || (Array.isArray(value) && value.length === 0))
    throw new WorkflowHeaderError('precondition_required');
  const candidate: unknown =
    Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (
    typeof candidate !== 'string' ||
    parseWorkflowInputCaseTag(candidate) === undefined
  )
    throw new WorkflowHeaderError('invalid');
  return candidate;
}
