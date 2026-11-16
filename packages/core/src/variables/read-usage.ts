import type { PoolClient } from 'pg';
import type { Role } from '@pertexo/policy';
import { readFolderScope } from '../shared/access/folder-access-facts.repository.js';
import type {
  VariableUsageInput,
  VariableUsagePage,
} from './workspace-variables.types.js';
import { walkVariableUsage } from './walk-usage.js';
import { readUsageWorkflow } from './usage.repository.js';

export async function readVariableUsage(
  client: PoolClient,
  input: VariableUsageInput,
  role: Role,
): Promise<VariableUsagePage> {
  const scope = await readFolderScope(client, input, role);
  return walkVariableUsage(input, (after) =>
    readUsageWorkflow(client, input.workspaceId, scope, after),
  );
}
