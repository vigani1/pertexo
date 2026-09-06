import { Inject, Injectable } from '@nestjs/common';

import { WorkspaceCapabilityGuard } from '../identity-workspace/guards.js';
import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';
import { RequestContextStore } from '../platform/http/index.js';
import { WORKFLOW_RUN_AUTHORIZATION } from './tokens.js';

@Injectable()
export class WorkflowRunReadGuard extends WorkspaceCapabilityGuard {
  public constructor(
    @Inject(WORKFLOW_RUN_AUTHORIZATION)
    authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('run:read', authorization, contexts, 'not_found', [
      'active',
      'suspended',
      'pending_deletion',
    ]);
  }
}

@Injectable()
export class WorkflowRunStartGuard extends WorkspaceCapabilityGuard {
  public constructor(
    @Inject(WORKFLOW_RUN_AUTHORIZATION)
    authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('run:start', authorization, contexts, 'not_found', ['active']);
  }
}

@Injectable()
export class WorkflowRunReplayGuard extends WorkspaceCapabilityGuard {
  public constructor(
    @Inject(WORKFLOW_RUN_AUTHORIZATION)
    authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('run:replay', authorization, contexts, 'not_found', ['active']);
  }
}

@Injectable()
export class WorkflowRunCancelGuard extends WorkspaceCapabilityGuard {
  public constructor(
    @Inject(WORKFLOW_RUN_AUTHORIZATION)
    authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('run:cancel', authorization, contexts, 'not_found', [
      'active',
      'suspended',
      'pending_deletion',
    ]);
  }
}
