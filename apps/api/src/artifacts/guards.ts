import { Inject, Injectable } from '@nestjs/common';

import { WorkspaceCapabilityGuard } from '../identity-workspace/guards.js';
import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';
import { RequestContextStore } from '../platform/http/index.js';
import { ARTIFACT_AUTHORIZATION } from './tokens.js';

@Injectable()
export class ArtifactUploadGuard extends WorkspaceCapabilityGuard {
  public constructor(
    @Inject(ARTIFACT_AUTHORIZATION)
    authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('artifact:upload', authorization, contexts, 'not_found', ['active']);
  }
}

@Injectable()
export class ArtifactReadGuard extends WorkspaceCapabilityGuard {
  public constructor(
    @Inject(ARTIFACT_AUTHORIZATION)
    authorization: WorkspaceAuthorizationSource,
    contexts: RequestContextStore,
  ) {
    super('artifact:read', authorization, contexts, 'not_found', ['active']);
  }
}
