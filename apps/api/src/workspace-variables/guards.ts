import { Inject, Injectable } from '@nestjs/common';
import { WorkspaceCapabilityGuard } from '../workspaces/http/guards.js';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { RequestContextStore } from '../platform/http/index.js';
export const VARIABLES_AUTHORIZATION = Symbol('VARIABLES_AUTHORIZATION');
@Injectable()
export class WorkspaceVariablesReadGuard extends WorkspaceCapabilityGuard {
  constructor(
    @Inject(VARIABLES_AUTHORIZATION)
    authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('workspace:read', authorization, contexts, 'not_found', [
      'active',
      'suspended',
      'pending_deletion',
    ]);
  }
}
@Injectable()
export class WorkspaceVariablesManageGuard extends WorkspaceCapabilityGuard {
  constructor(
    @Inject(VARIABLES_AUTHORIZATION)
    authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('variable:manage', authorization, contexts, 'not_found', ['active']);
  }
}
