import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  workflowRunRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { singleRequestHeader } from '../../platform/http/request-headers.js';
import { In, Route } from '../../workspaces/http/route.js';
import { authenticatedRequestIdentifiers } from '../../workspaces/request/authenticated-context.js';
import { caller, type WorkflowRunsRequest } from '../http/request-context.js';
import { GetRunRecoveryUseCase, RecoverRunUseCase } from './use-cases.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { runFailure } from '../../problems/context/normalize.js';

@UseInterceptors(domainErrors(runFailure))
@Controller()
export class RunRecoveryController {
  public constructor(
    private readonly preview: GetRunRecoveryUseCase,
    private readonly recover: RecoverRunUseCase,
  ) {}

  @Route(routes.recovery)
  public get(
    @Req() request: WorkflowRunsRequest,
    @In() { params }: RouteInput<typeof routes.recovery>,
  ) {
    return this.preview.execute({
      ...caller(request, params),
      runId: params.runId,
    });
  }

  @Route(routes.recover)
  public start(
    @Req() request: WorkflowRunsRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.recover>,
  ) {
    const traceparent = singleRequestHeader(request.headers, 'traceparent');
    return this.recover.execute({
      ...caller(request, params),
      runId: params.runId,
      workflowVersionId: body.workflowVersionId,
      nodeRunId: body.nodeRunId,
      ...(body.deadlineAt === undefined ? {} : { deadlineAt: body.deadlineAt }),
      ...(body.acknowledgePossibleEffects === undefined
        ? {}
        : { acknowledgePossibleEffects: body.acknowledgePossibleEffects }),
      ...(body.acknowledgeUnknownOutcome === undefined
        ? {}
        : { acknowledgeUnknownOutcome: body.acknowledgeUnknownOutcome }),
      idempotencyKey,
      ...authenticatedRequestIdentifiers(request),
      ...(traceparent === undefined ? {} : { traceparent }),
    });
  }
}
