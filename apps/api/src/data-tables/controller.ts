import { commandCredential } from '../authorization/credentials.js';
import { projectAuthenticatedWorkspaceContext } from '../workspaces/request/authenticated-context.js';
import { CsvExportAdmission } from '../platform/http/csv/admission.js';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { decodeTableExportRequest } from './export/request.js';
import { sendTableExport } from './export/response.js';
import { Controller, Req, Res, UseInterceptors } from '@nestjs/common';
import {
  dataTableRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { CsrfProtectionGuard } from '../workspaces/index.js';
import { In, Route } from '../workspaces/http/route.js';
import type { IdentityWorkspaceRequest } from '../workspaces/types.js';
import { withRequestOperationSignal } from '../platform/http/index.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';
import { DataTablesService } from './data-tables.service.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { dataTableFailure } from '../problems/context/normalize.js';

type Request = IdentityWorkspaceRequest & AbortableRequest;

@UseInterceptors(domainErrors(dataTableFailure))
@Controller()
export class DataTablesController {
  constructor(
    private readonly tables: DataTablesService,
    private readonly csrf: CsrfProtectionGuard,
    private readonly exports: CsvExportAdmission,
  ) {}

  @Route(routes.list)
  list(
    @Req() request: Request,
    @In() { params }: RouteInput<typeof routes.list>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tables.store.list({ ...scope(request, params), signal }),
    );
  }

  @Route(routes.create)
  create(
    @Req() request: Request,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.create>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tables.store.create({
        ...scope(request, params),
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
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.limits>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tables.store.configure({
        ...scope(request, params),
        ...body,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Route(routes.remove)
  remove(
    @Req() request: Request,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.remove>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tables.store.remove({
        ...scope(request, params),
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
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.editSchema>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tables.store.editSchema({
        ...scope(request, params),
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
    @Res() reply: FastifyReply,
    @In() { params }: RouteInput<typeof routes.export>,
  ) {
    const { query, csrfToken } = decodeTableExportRequest(
      request.body,
      request.headers['content-type'],
    );
    this.csrf.assertRequestAllowed(request, csrfToken);
    const tableScope = scope(request, params);
    await this.exports.run(tableScope.workspaceId, () =>
      sendTableExport(
        this.tables.store,
        { ...tableScope, tableId: params.tableId, query },
        request,
        reply,
      ),
    );
  }

  @Route(routes.find)
  find(
    @Req() request: Request,
    @In() { params, body }: RouteInput<typeof routes.find>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tables.store.find({
        ...scope(request, params),
        query: body,
        tableId: params.tableId,
        signal,
      }),
    );
  }

  @Route(routes.write)
  write(
    @Req() request: Request,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.write>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tables.store.write({
        ...scope(request, params),
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
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.importCsv>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tables.importCsv({
        ...scope(request, params),
        ...body,
        tableId: params.tableId,
        idempotencyKey,
        signal,
      }),
    );
  }
}

function scope(request: Request, params: Readonly<{ workspaceId: string }>) {
  const { actor } = projectAuthenticatedWorkspaceContext(
    request,
    params.workspaceId,
  );
  return {
    workspaceId: params.workspaceId,
    actorId: actor.actorId,
    ...commandCredential(actor),
  };
}
