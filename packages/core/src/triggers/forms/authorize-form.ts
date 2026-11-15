import { publicFormIsAvailable } from './public-form-standing.js';
import { rolesForCapability } from '@pertexo/policy';
import { authorizeWorkflowResource } from '../../shared/resources/workflow-authority.repository.js';
import type { PoolClient } from 'pg';
import { FormUnavailableError } from './form.errors.js';
import type { FormScope, PublicFormGrant } from './form-admission.types.js';
import { readGrantedFormStanding } from './form-versions.repository.js';

/**
 * Who may read or submit a published form: someone with its current link, on an
 * active workspace, or a member. Submitting takes the admission lock before this
 * check, so it can't use the authority helper, whose share locks must come first.
 */
export async function authorizeForm(
  client: PoolClient,
  input: FormScope,
  {
    grant,
    write,
  }: Readonly<{ grant: PublicFormGrant | undefined; write: boolean }>,
): Promise<void> {
  if (grant !== undefined) {
    if (
      input.workspaceId !== grant.workspaceId ||
      input.workflowId !== grant.workflowId
    )
      throw new FormUnavailableError();
    const standing = await readGrantedFormStanding(client, input, grant, write);
    if (standing === undefined || !publicFormIsAvailable(standing))
      throw new FormUnavailableError();
  } else {
    if (input.actorId === undefined) throw new FormUnavailableError();
    if (
      !(await authorizeWorkflowResource(
        client,
        { ...input, actorId: input.actorId },
        {
          capability: 'workflow:read',
          locking: write,
          roles: rolesForCapability('workspace:read'),
        },
      ))
    )
      throw new FormUnavailableError();
  }
}
