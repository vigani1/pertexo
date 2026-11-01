import {
  Body,
  Inject,
  Controller,
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
  UseInterceptors,
} from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  auditFilterSchema,
  auditQuerySchema,
  governanceUpdateSchema,
  workspaceIdentifierSchema,
} from '@pertexo/contracts';
import {
  SessionAuthenticationGuard,
  CsrfProtectionGuard,
  authenticatedSession,
} from '../workspaces/index.js';
import type { IdentityWorkspaceRequest } from '../workspaces/types.js';
import {
  requestIdempotencyKey,
  withRequestOperationSignal,
} from '../platform/http/index.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';
import { CsvExportAdmission } from '../platform/http/csv/admission.js';
import { decodeCsvDownloadRequest } from '../platform/http/csv/request.js';
import { sendCsvDownload } from '../platform/http/csv/response.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { GovernanceManageGuard, GovernanceGuard } from './guard.js';
import type { GovernanceStore } from '@pertexo/core/governance';
import { GOVERNANCE_STORE } from './tokens.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { resourceFailure } from '../problems/context/normalize.js';

type Request = IdentityWorkspaceRequest & AbortableRequest;
@UseInterceptors(domainErrors(resourceFailure))
@Controller('v1/workspaces/:workspaceId/governance')
@UseGuards(SessionAuthenticationGuard)
@RateLimit('authenticated_read')
export class GovernanceController {
  constructor(
    @Inject(GOVERNANCE_STORE) private readonly governance: GovernanceStore,
    private readonly exports: CsvExportAdmission,
    private readonly csrf: CsrfProtectionGuard,
  ) {}
  private scope(request: Request, workspace: unknown) {
    return {
      workspaceId: workspaceIdentifierSchema.parse(workspace),
      actorId: authenticatedSession(request).userId,
    };
  }
  @Get('audit')
  @UseGuards(GovernanceGuard)
  @Header('Cache-Control', 'private, no-store')
  list(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Query() raw: unknown,
  ) {
    const query = auditQuerySchema.parse(raw);
    return withRequestOperationSignal(request, (signal) =>
      this.governance.list({
        ...this.scope(request, workspace),
        query,
        signal,
      }),
    );
  }
  @Get('settings')
  @UseGuards(GovernanceGuard)
  @Header('Cache-Control', 'private, no-store')
  settings(@Req() request: Request, @Param('workspaceId') workspace: unknown) {
    return withRequestOperationSignal(request, (signal) =>
      this.governance.settings({
        ...this.scope(request, workspace),
        signal,
      }),
    );
  }
  @Put('settings')
  @UseGuards(GovernanceManageGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  @Header('Cache-Control', 'private, no-store')
  configure(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Body() raw: unknown,
  ) {
    const input = governanceUpdateSchema.parse(raw);
    return withRequestOperationSignal(request, (signal) =>
      this.governance.configure({
        ...this.scope(request, workspace),
        ...input,
        idempotencyKey: requestIdempotencyKey(request.headers),
        signal,
      }),
    );
  }
  @Post('audit/export')
  @UseGuards(GovernanceGuard)
  @HttpCode(200)
  @RateLimit('data_table_export')
  async exportCsv(
    @Req() request: Request & FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('workspaceId') workspace: unknown,
    @Body() raw: unknown,
  ) {
    const { query, csrfToken } = decodeCsvDownloadRequest(
      raw,
      request.headers['content-type'],
      (value) => auditFilterSchema.parse(value),
    );
    this.csrf.assertRequestAllowed(request, csrfToken);
    const scope = this.scope(request, workspace);
    await this.exports.run(scope.workspaceId, () =>
      sendCsvDownload(
        (signal, consume) =>
          this.governance.exportCsv({
            ...scope,
            query,
            signal,
            consume,
          }),
        request,
        reply,
      ),
    );
  }
}
