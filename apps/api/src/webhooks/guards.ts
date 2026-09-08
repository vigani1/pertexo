import { Inject, Injectable } from '@nestjs/common';

import { WorkspaceCapabilityGuard } from '../identity-workspace/guards.js';
import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';
import { RequestContextStore } from '../platform/http/index.js';
import { WEBHOOK_AUTHORIZATION } from './tokens.js';

@Injectable()
export class WebhookReadGuard extends WorkspaceCapabilityGuard {
  public constructor(
    @Inject(WEBHOOK_AUTHORIZATION) authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('workflow:read', authorization, contexts, 'not_found', ['active']);
  }
}

@Injectable()
export class WebhookUpdateGuard extends WorkspaceCapabilityGuard {
  public constructor(
    @Inject(WEBHOOK_AUTHORIZATION) authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('workflow:update', authorization, contexts, 'not_found', ['active']);
  }
}
