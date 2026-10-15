import { Inject, Injectable } from '@nestjs/common';
import { WorkspaceCapabilityGuard } from '../workspaces/http/guards.js';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { RequestContextStore } from '../platform/http/index.js';
export const TASK_AUTHORIZATION = Symbol('TASK_AUTHORIZATION');
@Injectable()
export class PendingTaskReadGuard extends WorkspaceCapabilityGuard {
  constructor(
    @Inject(TASK_AUTHORIZATION) authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('run:read', authorization, contexts, 'not_found', ['active']);
  }
}
@Injectable()
export class ApprovalAudienceGuard extends WorkspaceCapabilityGuard {
  constructor(
    @Inject(TASK_AUTHORIZATION) authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('workflow:update', authorization, contexts, 'not_found', ['active']);
  }
}
