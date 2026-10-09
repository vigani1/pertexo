import { Inject, Injectable } from '@nestjs/common';

import { WorkspaceCapabilityGuard } from '../workspaces/http/guards.js';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { RequestContextStore } from '../platform/http/index.js';
import { NOTIFICATION_AUTHORIZATION } from './tokens.js';

/** ADR 055: the inbox is readable only in an active workspace. */
@Injectable()
export class NotificationReadGuard extends WorkspaceCapabilityGuard {
  public constructor(
    @Inject(NOTIFICATION_AUTHORIZATION)
    authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('notification:read', authorization, contexts, 'not_found', [
      'active',
    ]);
  }
}
