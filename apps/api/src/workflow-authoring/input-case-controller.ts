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
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  parseWorkflowInputCaseTag,
  workflowIdParamSchema,
  workflowInputCaseParamSchema,
} from '@pertexo/contracts';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../identity-workspace/index.js';
import { projectAuthenticatedWorkspaceContext } from '../identity-workspace/authenticated-command-context.js';
import { withRequestOperationSignal } from '../platform/http/index.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';
import { requestHeaderValue } from '../platform/http/request-headers.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { throwWorkflowInputCaseApplicationError as throwWorkflowApplicationError } from './errors.js';
import { WorkflowReadGuard, WorkflowUpdateGuard } from './guards.js';
import { parseIdempotencyKey, WorkflowHeaderError } from './preconditions.js';
import type { WorkflowAuthoringRequest } from './types.js';
import { WorkflowInputCasesUseCase } from './input-case-use-case.js';

type Request = WorkflowAuthoringRequest & AbortableRequest;
@Controller('v1/workspaces/:workspaceId/workflows/:workflowId/input-cases')
@RateLimit('authenticated_read')
export class WorkflowInputCasesController {
  public constructor(private readonly cases: WorkflowInputCasesUseCase) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard)
  public async list(
    @Req() request: Request,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    try {
      const { workspaceId, workflowId } = workflowIdParamSchema.parse(params);
      return await withRequestOperationSignal(request, (signal) =>
        this.cases.list({
          ...context(request, workspaceId),
          workflowId,
          query,
          signal,
        }),
      );
    } catch (error) {
      return throwWorkflowApplicationError(error);
    }
  }
  @Get(':caseId')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard)
  public async get(
    @Req() request: Request,
    @Param() params: unknown,
    @Res({ passthrough: true })
    response: Readonly<{ header(name: string, value: string): unknown }>,
  ) {
    try {
      const { workspaceId, workflowId, caseId } =
        workflowInputCaseParamSchema.parse(params);
      const result = await withRequestOperationSignal(request, (signal) =>
        this.cases.get({
          ...context(request, workspaceId),
          workflowId,
          caseId,
          signal,
        }),
      );
      response.header('ETag', result.case.representationTag);
      return result;
    } catch (error) {
      return throwWorkflowApplicationError(error);
    }
  }
  @Post()
  @RateLimit('ordinary_mutation')
  @HttpCode(201)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowUpdateGuard,
    CsrfProtectionGuard,
  )
  public async create(
    @Req() request: Request,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    try {
      const { workspaceId, workflowId } = workflowIdParamSchema.parse(params);
      const idempotencyKey = parseIdempotencyKey(
        requestHeaderValue(request.headers, 'idempotency-key'),
      );
      return await withRequestOperationSignal(request, (signal) =>
        this.cases.create({
          ...context(request, workspaceId),
          workflowId,
          request: body,
          idempotencyKey,
          signal,
        }),
      );
    } catch (error) {
      return throwWorkflowApplicationError(error);
    }
  }
  @Put(':caseId')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowUpdateGuard,
    CsrfProtectionGuard,
  )
  public async update(
    @Req() request: Request,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    try {
      const { workspaceId, workflowId, caseId } =
        workflowInputCaseParamSchema.parse(params);
      const representationTag = parseCaseIfMatch(
        requestHeaderValue(request.headers, 'if-match'),
      );
      const idempotencyKey = parseIdempotencyKey(
        requestHeaderValue(request.headers, 'idempotency-key'),
      );
      return await withRequestOperationSignal(request, (signal) =>
        this.cases.update({
          ...context(request, workspaceId),
          workflowId,
          caseId,
          request: body,
          representationTag,
          idempotencyKey,
          signal,
        }),
      );
    } catch (error) {
      return throwWorkflowApplicationError(error);
    }
  }
  @Delete(':caseId')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowUpdateGuard,
    CsrfProtectionGuard,
  )
  public async delete(@Req() request: Request, @Param() params: unknown) {
    try {
      const { workspaceId, workflowId, caseId } =
        workflowInputCaseParamSchema.parse(params);
      const representationTag = parseCaseIfMatch(
        requestHeaderValue(request.headers, 'if-match'),
      );
      const idempotencyKey = parseIdempotencyKey(
        requestHeaderValue(request.headers, 'idempotency-key'),
      );
      return await withRequestOperationSignal(request, (signal) =>
        this.cases.delete({
          ...context(request, workspaceId),
          workflowId,
          caseId,
          representationTag,
          idempotencyKey,
          signal,
        }),
      );
    } catch (error) {
      return throwWorkflowApplicationError(error);
    }
  }
}
function context(request: WorkflowAuthoringRequest, workspaceId: string) {
  return {
    ...projectAuthenticatedWorkspaceContext(request, workspaceId),
    routeWorkspaceId: workspaceId,
  };
}
export function parseCaseIfMatch(value: unknown): string {
  if (value === undefined || (Array.isArray(value) && value.length === 0))
    throw new WorkflowHeaderError('precondition_required', 'If-Match');
  const candidate: unknown =
    Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (
    typeof candidate !== 'string' ||
    parseWorkflowInputCaseTag(candidate) === undefined
  )
    throw new WorkflowHeaderError('invalid', 'If-Match');
  return candidate;
}
