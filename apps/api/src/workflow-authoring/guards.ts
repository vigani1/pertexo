import { Inject, Injectable } from '@nestjs/common';

import { WorkspaceCapabilityGuard } from '../identity-workspace/guards.js';
import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';
import { RequestContextStore } from '../platform/http/index.js';
import { WORKFLOW_AUTHORING_AUTHORIZATION } from './tokens.js';

abstract class WorkflowCapabilityGuard extends WorkspaceCapabilityGuard {
  protected constructor(
    capability:
      | 'workflow:create'
      | 'workflow:publish'
      | 'workflow:read'
      | 'workflow:update',
    authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super(capability, authorization, contexts, 'not_found', ['active']);
  }
}

@Injectable()
export class WorkflowReadGuard extends WorkflowCapabilityGuard {
  public constructor(
    @Inject(WORKFLOW_AUTHORING_AUTHORIZATION)
    authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('workflow:read', authorization, contexts);
  }
}

@Injectable()
export class WorkflowCreateGuard extends WorkflowCapabilityGuard {
  public constructor(
    @Inject(WORKFLOW_AUTHORING_AUTHORIZATION)
    authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('workflow:create', authorization, contexts);
  }
}

@Injectable()
export class WorkflowUpdateGuard extends WorkflowCapabilityGuard {
  public constructor(
    @Inject(WORKFLOW_AUTHORING_AUTHORIZATION)
    authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('workflow:update', authorization, contexts);
  }
}

@Injectable()
export class WorkflowPublishGuard extends WorkflowCapabilityGuard {
  public constructor(
    @Inject(WORKFLOW_AUTHORING_AUTHORIZATION)
    authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('workflow:publish', authorization, contexts);
  }
}
