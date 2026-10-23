import {
  Body,
  Controller,
  Get,
  Put,
  Param,
  Query,
  Req,
  UseGuards,
  Header,
  UseInterceptors,
} from '@nestjs/common';
import {
  workspaceIdentifierSchema,
  workspaceVariablesRequestSchema,
  workspaceVariableUsageQuerySchema,
} from '@pertexo/contracts';
import {
  SessionAuthenticationGuard,
  CsrfProtectionGuard,
  authenticatedSession,
} from '../workspaces/index.js';
import type { IdentityWorkspaceRequest } from '../workspaces/types.js';
import { authenticatedRequestIdentifiers } from '../workspaces/request/authenticated-context.js';
import {
  requestIdempotencyKey,
  withRequestOperationSignal,
} from '../platform/http/index.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import {
  WorkspaceVariablesReadGuard,
  WorkspaceVariablesManageGuard,
} from './guards.js';
import { WorkspaceVariablesService } from './service.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { resourceFailure } from '../problems/context/normalize.js';

type Request = IdentityWorkspaceRequest & AbortableRequest;
@UseInterceptors(domainErrors(resourceFailure))
@Controller('v1/workspaces/:workspaceId/variables')
@UseGuards(SessionAuthenticationGuard)
@RateLimit('authenticated_read')
export class WorkspaceVariablesController {
  constructor(private readonly variables: WorkspaceVariablesService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WorkspaceVariablesReadGuard)
  read(@Req() request: Request, @Param('workspaceId') workspace: unknown) {
    const workspaceId = workspaceIdentifierSchema.parse(workspace);
    return withRequestOperationSignal(request, (signal) =>
      this.variables.read({
        workspaceId,
        actorId: authenticatedSession(request).userId,
        signal,
      }),
    );
  }
  @Get('usage')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WorkspaceVariablesReadGuard)
  usage(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Query() query: unknown,
  ) {
    const workspaceId = workspaceIdentifierSchema.parse(workspace);
    const input = workspaceVariableUsageQuerySchema.parse(query);
    return withRequestOperationSignal(request, (signal) =>
      this.variables.usage({
        workspaceId,
        actorId: authenticatedSession(request).userId,
        ...input,
        signal,
      }),
    );
  }
  @Put()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WorkspaceVariablesManageGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  replace(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Body() body: unknown,
  ) {
    const workspaceId = workspaceIdentifierSchema.parse(workspace);
    const input = workspaceVariablesRequestSchema.parse(body);
    const idempotencyKey = requestIdempotencyKey(request.headers);
    return withRequestOperationSignal(request, (signal) =>
      this.variables.replace({
        workspaceId,
        actorId: authenticatedSession(request).userId,
        ...input,
        idempotencyKey,
        ...authenticatedRequestIdentifiers(request),
        signal,
      }),
    );
  }
}
