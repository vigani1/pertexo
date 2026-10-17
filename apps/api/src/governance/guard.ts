import { Inject, Injectable } from '@nestjs/common';
import { WorkspaceCapabilityGuard } from '../workspaces/http/guards.js';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { RequestContextStore } from '../platform/http/index.js';
export const GOVERNANCE_AUTHORIZATION = Symbol('GOVERNANCE_AUTHORIZATION');
@Injectable()
export class GovernanceGuard extends WorkspaceCapabilityGuard {
  constructor(
    @Inject(GOVERNANCE_AUTHORIZATION)
    authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('audit:read', authorization, contexts, 'not_found', [
      'active',
      'suspended',
      'pending_deletion',
    ]);
  }
}
