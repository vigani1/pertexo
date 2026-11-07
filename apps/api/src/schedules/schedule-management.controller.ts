import { commandCredential } from '../authorization/credentials.js';
import { projectAuthenticatedWorkspaceContext } from '../workspaces/request/authenticated-context.js';
import { Controller, Req, UseInterceptors } from '@nestjs/common';
import { SCHEDULE_FIRE_TIME_DEFAULT_COUNT } from '@pertexo/contracts';
import {
  scheduleRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { requestIdentifier, traceIdentifier } from '../workspaces/index.js';
import { In, Route } from '../workspaces/http/route.js';
import type { IdentityWorkspaceRequest } from '../workspaces/workspace-transport.js';
import { ScheduleManagementService } from './schedule-management.service.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { authoringFailure } from '../problems/context/normalize-context-errors.js';

type Request = IdentityWorkspaceRequest;
type TriggerCommand = RouteInput<typeof routes.enable>;

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class ScheduleManagementController {
  public constructor(private readonly service: ScheduleManagementService) {}

  @Route(routes.list)
  public list(
    @Req() request: Request,
    @In() { params }: RouteInput<typeof routes.list>,
  ) {
    return this.service.list({
      ...params,
      actorId: projectAuthenticatedWorkspaceContext(request, params.workspaceId)
        .actor.actorId,
    });
  }

  @Route(routes.occurrences)
  public occurrences(
    @Req() request: Request,
    @In() { params, query }: RouteInput<typeof routes.occurrences>,
  ) {
    return this.service.listOccurrences({
      ...params,
      actorId: projectAuthenticatedWorkspaceContext(request, params.workspaceId)
        .actor.actorId,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.after === undefined ? {} : { after: query.after }),
    });
  }

  @Route(routes.nextRuns)
  public nextRuns(
    @Req() request: Request,
    @In() { params, query }: RouteInput<typeof routes.nextRuns>,
  ) {
    return this.service.nextRuns({
      ...params,
      actorId: projectAuthenticatedWorkspaceContext(request, params.workspaceId)
        .actor.actorId,
      count: query.count ?? SCHEDULE_FIRE_TIME_DEFAULT_COUNT,
    });
  }

  @Route(routes.preview)
  public preview(
    @Req() request: Request,
    @In() { params, body }: RouteInput<typeof routes.preview>,
  ) {
    return this.service.previewRuns({
      ...params,
      actorId: projectAuthenticatedWorkspaceContext(request, params.workspaceId)
        .actor.actorId,
      config: body.config,
      count: body.count ?? SCHEDULE_FIRE_TIME_DEFAULT_COUNT,
    });
  }

  @Route(routes.enable)
  public enable(@Req() request: Request, @In() input: TriggerCommand) {
    return this.setEnabled(request, input, true);
  }

  @Route(routes.disable)
  public disable(@Req() request: Request, @In() input: TriggerCommand) {
    return this.setEnabled(request, input, false);
  }

  private setEnabled(
    request: Request,
    { params, idempotencyKey }: TriggerCommand,
    enabled: boolean,
  ) {
    const { actor } = projectAuthenticatedWorkspaceContext(
      request,
      params.workspaceId,
    );
    const traceId = traceIdentifier(request);
    return this.service.setEnabled(
      {
        ...params,
        actorId: actor.actorId,
        ...commandCredential(actor),
        idempotencyKey,
        requestId: requestIdentifier(request),
        ...(traceId === undefined ? {} : { traceId }),
      },
      { enabled },
    );
  }
}
