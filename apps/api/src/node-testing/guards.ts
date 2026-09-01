import { Inject, Injectable } from '@nestjs/common';

import { WorkspaceCapabilityGuard } from '../identity-workspace/guards.js';
import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';
import { RequestContextStore } from '../platform/http/index.js';
import { NODE_TESTING_AUTHORIZATION } from './tokens.js';

@Injectable()
export class NodeTestingUpdateGuard extends WorkspaceCapabilityGuard {
  public constructor(
    @Inject(NODE_TESTING_AUTHORIZATION)
    authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('workflow:update', authorization, contexts, 'not_found', ['active']);
  }
}
