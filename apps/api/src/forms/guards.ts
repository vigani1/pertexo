import { Inject, Injectable } from '@nestjs/common';
import { WorkspaceCapabilityGuard } from '../workspaces/http/guards.js';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { RequestContextStore } from '../platform/http/index.js';
export const FORM_AUTHORIZATION = Symbol('FORM_AUTHORIZATION');
@Injectable()
export class FormMemberGuard extends WorkspaceCapabilityGuard {
  constructor(
    @Inject(FORM_AUTHORIZATION) authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('workspace:read', authorization, contexts, 'not_found', ['active']);
  }
}
@Injectable()
export class FormManageGuard extends WorkspaceCapabilityGuard {
  constructor(
    @Inject(FORM_AUTHORIZATION) authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('workflow:update', authorization, contexts, 'not_found', ['active']);
  }
}
