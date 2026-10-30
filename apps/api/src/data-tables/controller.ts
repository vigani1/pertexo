import { CsvExportAdmission } from '../platform/http/csv/admission.js';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { decodeTableExportRequest } from './export/request.js';
import { sendTableExport } from './export/response.js';
import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Req,
  Res,
  UseGuards,
  Header,
  HttpCode,
  UseInterceptors,
} from '@nestjs/common';
import {
  workspaceIdentifierSchema,
  dataTableCreateSchema,
  dataTableSchemaEditSchema,
  dataTableLimitsSchema,
  dataTableRemoveSchema,
  dataTableQuerySchema,
  dataTableWriteSchema,
  dataTableCsvImportSchema,
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
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { DataTablesReadGuard, DataTablesManageGuard } from './guards.js';
import { DataTablesService } from './service.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { dataTableFailure } from '../problems/context/normalize.js';

type Request = IdentityWorkspaceRequest & AbortableRequest;
@UseInterceptors(domainErrors(dataTableFailure))
@Controller('v1/workspaces/:workspaceId/data-tables')
@UseGuards(SessionAuthenticationGuard)
@RateLimit('authenticated_read')
export class DataTablesController {
  constructor(
    private readonly tables: DataTablesService,
    private readonly csrf: CsrfProtectionGuard,
    private readonly exports: CsvExportAdmission,
  ) {}
  private scope(request: Request, workspace: unknown) {
    return {
      workspaceId: workspaceIdentifierSchema.parse(workspace),
      actorId: authenticatedSession(request).userId,
    };
  }
  @Get()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(DataTablesReadGuard)
  list(@Req() request: Request, @Param('workspaceId') workspace: unknown) {
    return withRequestOperationSignal(request, (signal) =>
      this.tables.store.list({ ...this.scope(request, workspace), signal }),
    );
  }
  @Post()
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(200)
  @UseGuards(DataTablesManageGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  create(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Body() body: unknown,
  ) {
    const input = dataTableCreateSchema.parse(body);
    return withRequestOperationSignal(request, (signal) =>
      this.tables.store.create({
        ...this.scope(request, workspace),
        ...input,
        keyColumn: input.keyColumn ?? null,
        idempotencyKey: requestIdempotencyKey(request.headers),
        signal,
      }),
    );
  }
  @Put('limits')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(DataTablesManageGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  limits(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Body() body: unknown,
  ) {
    const input = dataTableLimitsSchema.parse(body);
    return withRequestOperationSignal(request, (signal) =>
      this.tables.store.configure({
        ...this.scope(request, workspace),
        ...input,
        idempotencyKey: requestIdempotencyKey(request.headers),
        signal,
      }),
    );
  }
  @Delete(':tableId')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(DataTablesManageGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  remove(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Param('tableId') table: unknown,
    @Body() body: unknown,
  ) {
    const input = dataTableRemoveSchema.parse(body);
    const tableId = workspaceIdentifierSchema.parse(table);
    return withRequestOperationSignal(request, (signal) =>
      this.tables.store.remove({
        ...this.scope(request, workspace),
        ...input,
        tableId,
        idempotencyKey: requestIdempotencyKey(request.headers),
        signal,
      }),
    );
  }
  @Put(':tableId/schema')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(DataTablesManageGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  editSchema(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Param('tableId') table: unknown,
    @Body() body: unknown,
  ) {
    const input = dataTableSchemaEditSchema.parse(body);
    const tableId = workspaceIdentifierSchema.parse(table);
    return withRequestOperationSignal(request, (signal) =>
      this.tables.store.editSchema({
        ...this.scope(request, workspace),
        ...input,
        tableId,
        idempotencyKey: requestIdempotencyKey(request.headers),
        signal,
      }),
    );
  }
  // Nest binds these five route arguments independently; retain validation order.
  // eslint-disable-next-line max-params
  @Post(':tableId/export')
  @HttpCode(200)
  @UseGuards(DataTablesReadGuard)
  @RateLimit('data_table_export')
  async exportCsv(
    @Req() request: Request & FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('workspaceId') workspace: unknown,
    @Param('tableId') table: unknown,
    @Body() body: unknown,
  ) {
    const { query, csrfToken } = decodeTableExportRequest(
      body,
      request.headers['content-type'],
    );
    this.csrf.assertRequestAllowed(request, csrfToken);
    const scope = this.scope(request, workspace);
    const tableId = workspaceIdentifierSchema.parse(table);
    await this.exports.run(scope.workspaceId, () =>
      sendTableExport(
        this.tables.store,
        { ...scope, tableId, query },
        request,
        reply,
      ),
    );
  }
  @Post(':tableId/rows/query')
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(200)
  @UseGuards(DataTablesReadGuard, CsrfProtectionGuard)
  find(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Param('tableId') table: unknown,
    @Body() body: unknown,
  ) {
    const query = dataTableQuerySchema.parse(body);
    const tableId = workspaceIdentifierSchema.parse(table);
    return withRequestOperationSignal(request, (signal) =>
      this.tables.store.find({
        ...this.scope(request, workspace),
        query,
        tableId,
        signal,
      }),
    );
  }
  @Post(':tableId/rows')
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(200)
  @UseGuards(DataTablesManageGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  write(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Param('tableId') table: unknown,
    @Body() body: unknown,
  ) {
    const input = dataTableWriteSchema.parse(body);
    const tableId = workspaceIdentifierSchema.parse(table);
    return withRequestOperationSignal(request, (signal) =>
      this.tables.store.write({
        ...this.scope(request, workspace),
        command: input.command,
        ...('rowId' in input
          ? { rowId: input.rowId, expectedRevision: input.expectedRevision }
          : {}),
        tableId,
        idempotencyKey: requestIdempotencyKey(request.headers),
        signal,
      }),
    );
  }
  @Post(':tableId/import')
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(200)
  @UseGuards(DataTablesManageGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  importCsv(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Param('tableId') table: unknown,
    @Body() body: unknown,
  ) {
    const input = dataTableCsvImportSchema.parse(body);
    const tableId = workspaceIdentifierSchema.parse(table);
    return withRequestOperationSignal(request, (signal) =>
      this.tables.importCsv({
        ...this.scope(request, workspace),
        ...input,
        tableId,
        idempotencyKey: requestIdempotencyKey(request.headers),
        signal,
      }),
    );
  }
}
