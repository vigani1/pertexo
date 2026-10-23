import {
  createActorContext,
  type WorkspaceAccess,
} from '../../../src/authorization/index.js';

export const workspaceId = '11111111-1111-4111-8111-111111111111';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export function actor() {
  return createActorContext({
    actorId,
    workspaceId,
    sessionId: '22222222-2222-4222-8222-222222222222',
    requestId: 'request-a',
    traceId: 'trace-a',
  });
}

export function access(
  overrides: Partial<WorkspaceAccess> = {},
): WorkspaceAccess {
  return {
    actorId,
    workspaceId,
    role: 'viewer',
    membershipStatus: 'active',
    workspaceStatus: 'active',
    ...overrides,
  };
}
