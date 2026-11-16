import type { PoolClient } from 'pg';
import {
  rolesForCapability,
  type AuthorizationCapability,
} from '@pertexo/policy';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import type { PromotionScope } from './workflow-promotion.types.js';

export function requirePromotionAuthority(
  client: PoolClient,
  input: PromotionScope,
  capability: AuthorizationCapability = 'workflow:update',
  { browsing = false }: Readonly<{ browsing?: boolean }> = {},
) {
  return lockWorkflowAuthoringAuthority(client, input.workspaceId, {
    actorId: input.actorId,
    browsing,
    roles: rolesForCapability(capability),
  });
}
