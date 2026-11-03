import { Controller, Req, UseInterceptors } from '@nestjs/common';
import { SCHEDULE_FIRE_TIME_DEFAULT_COUNT } from '@pertexo/contracts';
import {
  scheduleRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import {
  authenticatedSession,
  requestIdentifier,
  traceIdentifier,
} from '../workspaces/index.js';
import { In, Route } from '../workspaces/http/route.js';
import type { IdentityWorkspaceRequest } from '../workspaces/types.js';
import { ScheduleManagementService } from './service.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { authoringFailure } from '../problems/context/normalize.js';

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
      actorId: authenticatedSession(request).userId,
    });
  }

  @Route(routes.occurrences)
  public occurrences(
    @Req() request: Request,
    @In() { params, query }: RouteInput<typeof routes.occurrences>,
  ) {
    return this.service.listOccurrences({
      ...params,
      actorId: authenticatedSession(request).userId,
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
      actorId: authenticatedSession(request).userId,
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
      actorId: authenticatedSession(request).userId,
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
    const traceId = traceIdentifier(request);
    return this.service.setEnabled(
      {
        ...params,
        actorId: authenticatedSession(request).userId,
        idempotencyKey,
        requestId: requestIdentifier(request),
        ...(traceId === undefined ? {} : { traceId }),
      },
      { enabled },
    );
  }
}
