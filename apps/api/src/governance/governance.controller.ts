import { Inject, Controller, Req, Res, UseInterceptors } from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { auditFilterSchema } from '@pertexo/contracts';
import {
  governanceRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import type { GovernanceStore } from '@pertexo/core/governance';
import { CsrfProtectionGuard } from '../workspaces/index.js';
import { In, Route } from '../platform/http/route.js';
import type { IdentityWorkspaceRequest } from '../workspaces/workspace-transport.js';
import { withRequestOperationSignal } from '../platform/http/index.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';
import { CsvExportAdmission } from '../platform/http/csv/csv-admission.js';
import { decodeCsvDownloadRequest } from '../platform/http/csv/csv-request.js';
import { parseRequestInput } from '../platform/http/request-input.js';
import { sendCsvDownload } from '../platform/http/csv/csv-response.js';
import { GOVERNANCE_STORE } from './tokens.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { resourceFailure } from '../problems/context/normalize-context-errors.js';
import {
  Caller,
  storeCaller,
  type WorkspaceCaller,
} from '../workspaces/request/caller.js';

type Request = IdentityWorkspaceRequest & AbortableRequest;

@UseInterceptors(domainErrors(resourceFailure))
@Controller()
export class GovernanceController {
  constructor(
    @Inject(GOVERNANCE_STORE) private readonly governance: GovernanceStore,
    private readonly exports: CsvExportAdmission,
    private readonly csrf: CsrfProtectionGuard,
  ) {}

  @Route(routes.audit)
  list(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { query }: RouteInput<typeof routes.audit>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.governance.list({ ...storeCaller(caller), query, signal }),
    );
  }

  @Route(routes.settings)
  settings(@Req() request: Request, @Caller() caller: WorkspaceCaller) {
    return withRequestOperationSignal(request, (signal) =>
      this.governance.settings({ ...storeCaller(caller), signal }),
    );
  }

  @Route(routes.configure)
  configure(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { body, idempotencyKey }: RouteInput<typeof routes.configure>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.governance.configure({
        ...storeCaller(caller),
        ...body,
        idempotencyKey,
        signal,
      }),
    );
  }

  /** A native form can't set a header, so its CSRF token comes in the body. */
  @Route(routes.export)
  async exportCsv(
    @Req() request: Request & FastifyRequest,
    @Caller() caller: WorkspaceCaller,
    @Res() reply: FastifyReply,
  ) {
    const { query, csrfToken } = decodeCsvDownloadRequest(
      request.body,
      request.headers['content-type'],
      (value) => parseRequestInput(auditFilterSchema, value),
    );
    this.csrf.assertRequestAllowed(request, csrfToken);
    const owner = storeCaller(caller);
    await this.exports.run(owner.workspaceId, () =>
      sendCsvDownload(
        (signal, consume) =>
          this.governance.exportCsv({ ...owner, query, signal, consume }),
        request,
        reply,
      ),
    );
  }
}
