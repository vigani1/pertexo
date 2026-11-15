import { publicFormIsAvailable } from './public-form-standing.js';
import type { Pool } from 'pg';

import { capabilityHash } from './access.repository.js';
import type {
  DiscoverFormInput,
  PublicFormGrant,
} from './form-admission.types.js';
import { FormUnavailableError } from './form.errors.js';
import { lookupPublicForm } from './discover.repository.js';

/** No member behind this one either: it turns a link into a grant. */
export async function discoverPublicForm(
  pool: Pool,
  input: DiscoverFormInput,
): Promise<PublicFormGrant> {
  const digest = capabilityHash(input.capability);
  const row = await lookupPublicForm(pool, input.publicId, digest);
  if (row === undefined || !publicFormIsAvailable(row))
    throw new FormUnavailableError();
  return {
    workspaceId: row.workspaceId,
    workflowId: row.workflowId,
    nodeId: row.nodeId,
    publicId: input.publicId,
    capabilityHash: digest,
  };
}
