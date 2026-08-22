import { Inject, Injectable } from '@nestjs/common';

import { WorkspaceCapabilityGuard } from '../identity-workspace/guards.js';
import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';
import { RequestContextStore } from '../platform/http/index.js';
import { CONNECTION_AUTHORIZATION } from './tokens.js';

@Injectable()
export class ConnectionManageGuard extends WorkspaceCapabilityGuard {
  public constructor(
    @Inject(CONNECTION_AUTHORIZATION)
    authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('connection:manage', authorization, contexts, 'not_found', [
      'active',
    ]);
  }
}

@Injectable()
export class ConnectionUseGuard extends WorkspaceCapabilityGuard {
  public constructor(
    @Inject(CONNECTION_AUTHORIZATION)
    authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('connection:use', authorization, contexts, 'not_found', ['active']);
  }
}
