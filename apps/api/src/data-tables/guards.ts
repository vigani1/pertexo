import { Inject, Injectable } from '@nestjs/common';
import { WorkspaceCapabilityGuard } from '../workspaces/http/guards.js';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { RequestContextStore } from '../platform/http/index.js';
export const TABLE_AUTHORIZATION = Symbol('TABLE_AUTHORIZATION');
@Injectable()
export class DataTablesReadGuard extends WorkspaceCapabilityGuard {
  constructor(
    @Inject(TABLE_AUTHORIZATION) authorization: WorkspaceAuthorizationSource,
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
export class DataTablesManageGuard extends WorkspaceCapabilityGuard {
  constructor(
    @Inject(TABLE_AUTHORIZATION) authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('workflow:update', authorization, contexts, 'not_found', ['active']);
  }
}
