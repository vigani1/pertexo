import { Inject, Controller, Req, Res, UseInterceptors } from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { auditFilterSchema } from '@pertexo/contracts';
import {
  governanceRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import type { GovernanceStore } from '@pertexo/core/governance';
import {
  CsrfProtectionGuard,
  authenticatedSession,
} from '../workspaces/index.js';
import { In, Route } from '../workspaces/http/route.js';
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
    @In() { params, query }: RouteInput<typeof routes.audit>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.governance.list({ ...scope(request, params), query, signal }),
    );
  }

  @Route(routes.settings)
  settings(
    @Req() request: Request,
    @In() { params }: RouteInput<typeof routes.settings>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.governance.settings({ ...scope(request, params), signal }),
    );
  }

  @Route(routes.configure)
  configure(
    @Req() request: Request,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.configure>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.governance.configure({
        ...scope(request, params),
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
    @Res() reply: FastifyReply,
    @In() { params }: RouteInput<typeof routes.export>,
  ) {
    const { query, csrfToken } = decodeCsvDownloadRequest(
      request.body,
      request.headers['content-type'],
      (value) => parseRequestInput(auditFilterSchema, value),
    );
    this.csrf.assertRequestAllowed(request, csrfToken);
    const owner = scope(request, params);
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

function scope(
  request: Request,
  { workspaceId }: Readonly<{ workspaceId: string }>,
) {
  return { workspaceId, actorId: authenticatedSession(request).userId };
}
