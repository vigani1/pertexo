import { CsvExportAdmission } from '../platform/http/csv/csv-admission.js';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { decodeTableExportRequest } from './export/request.js';
import { sendTableExport } from './export/response.js';
import { Controller, Inject, Req, Res, UseInterceptors } from '@nestjs/common';
import {
  dataTableRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { CsrfProtectionGuard } from '../workspaces/index.js';
import { In, Route } from '../platform/http/route.js';
import type { IdentityWorkspaceRequest } from '../workspaces/workspace-transport.js';
import { withRequestOperationSignal } from '../platform/http/index.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';
import type { DataTablesStore } from '@pertexo/core/data-tables';
import { DATA_TABLES_STORE } from './data-tables.tokens.js';
import { importCsvRows } from './import-csv-rows.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { dataTableFailure } from '../problems/context/normalize-context-errors.js';
import {
  Caller,
  storeCaller,
  type WorkspaceCaller,
} from '../workspaces/request/caller.js';

type Request = IdentityWorkspaceRequest & AbortableRequest;

@UseInterceptors(domainErrors(dataTableFailure))
@Controller()
export class DataTablesController {
  constructor(
    @Inject(DATA_TABLES_STORE) private readonly store: DataTablesStore,
    private readonly csrf: CsrfProtectionGuard,
    private readonly exports: CsvExportAdmission,
  ) {}

  @Route(routes.list)
  list(@Req() request: Request, @Caller() caller: WorkspaceCaller) {
    return withRequestOperationSignal(request, (signal) =>
      this.store.list({ ...storeCaller(caller), signal }),
    );
  }

  @Route(routes.create)
  create(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { body, idempotencyKey }: RouteInput<typeof routes.create>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.store.create({
        ...storeCaller(caller),
        ...body,
        keyColumn: body.keyColumn ?? null,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Route(routes.limits)
  limits(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { body, idempotencyKey }: RouteInput<typeof routes.limits>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.store.configure({
        ...storeCaller(caller),
        ...body,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Route(routes.remove)
  remove(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.remove>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.store.remove({
        ...storeCaller(caller),
        ...body,
        tableId: params.tableId,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Route(routes.editSchema)
  editSchema(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.editSchema>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.store.editSchema({
        ...storeCaller(caller),
        ...body,
        tableId: params.tableId,
        idempotencyKey,
        signal,
      }),
    );
  }

  /** A native form can post this, so the body is read here, CSRF token included. */
  @Route(routes.export)
  async exportCsv(
    @Req() request: Request & FastifyRequest,
    @Caller() caller: WorkspaceCaller,
    @Res() reply: FastifyReply,
    @In() { params }: RouteInput<typeof routes.export>,
  ) {
    const { query, csrfToken } = decodeTableExportRequest(
      request.body,
      request.headers['content-type'],
    );
    this.csrf.assertRequestAllowed(request, csrfToken);
    const tableScope = storeCaller(caller);
    await this.exports.run(tableScope.workspaceId, () =>
      sendTableExport(
        this.store,
        { ...tableScope, tableId: params.tableId, query },
        request,
        reply,
      ),
    );
  }

  @Route(routes.find)
  find(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body }: RouteInput<typeof routes.find>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.store.find({
        ...storeCaller(caller),
        query: body,
        tableId: params.tableId,
        signal,
      }),
    );
  }

  @Route(routes.write)
  write(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.write>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.store.write({
        ...storeCaller(caller),
        command: body.command,
        ...('rowId' in body
          ? { rowId: body.rowId, expectedRevision: body.expectedRevision }
          : {}),
        tableId: params.tableId,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Route(routes.importCsv)
  importCsv(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.importCsv>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      importCsvRows(this.store, {
        ...storeCaller(caller),
        ...body,
        tableId: params.tableId,
        idempotencyKey,
        signal,
      }),
    );
  }
}
