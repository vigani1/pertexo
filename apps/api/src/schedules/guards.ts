import { Inject, Injectable } from '@nestjs/common';

import { WorkspaceCapabilityGuard } from '../identity-workspace/guards.js';
import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';
import { RequestContextStore } from '../platform/http/index.js';

export const SCHEDULE_AUTHORIZATION = Symbol('SCHEDULE_AUTHORIZATION');

@Injectable()
export class ScheduleReadGuard extends WorkspaceCapabilityGuard {
  public constructor(
    @Inject(SCHEDULE_AUTHORIZATION) authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('workflow:read', authorization, contexts, 'not_found', ['active']);
  }
}

@Injectable()
export class ScheduleUpdateGuard extends WorkspaceCapabilityGuard {
  public constructor(
    @Inject(SCHEDULE_AUTHORIZATION) authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('workflow:update', authorization, contexts, 'not_found', ['active']);
  }
}
