import { Controller, UseInterceptors } from '@nestjs/common';
import {
  assistantRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../../platform/http/route.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize-context-errors.js';
import {
  Caller,
  serviceCaller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';
import { ExplanationService } from './explanation.service.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class ExplanationController {
  constructor(private readonly service: ExplanationService) {}

  @Route(routes.settings)
  settings(@Caller() caller: WorkspaceCaller) {
    return this.service.readSettings(serviceCaller(caller));
  }

  @Route(routes.updateSettings)
  updateSettings(
    @Caller() caller: WorkspaceCaller,
    @In() { body }: RouteInput<typeof routes.updateSettings>,
  ) {
    return this.service.updateSettings(serviceCaller(caller), body);
  }

  @Route(routes.disclosure)
  disclosure(
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.disclosure>,
  ) {
    return this.service.disclosure({
      ...serviceCaller(caller),
      runId: params.runId,
    });
  }

  @Route(routes.explain)
  explain(
    @Caller() caller: WorkspaceCaller,
    @In() { params, body }: RouteInput<typeof routes.explain>,
  ) {
    return this.service.explain(
      { ...serviceCaller(caller), runId: params.runId },
      body.confirmation,
    );
  }
}
