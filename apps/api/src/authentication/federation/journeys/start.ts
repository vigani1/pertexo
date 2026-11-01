import type { OrganizationSignInCommands } from '@pertexo/core/tenant-access';
import {
  FederationConflictError,
  WorkspaceAccessDeniedError,
} from '@pertexo/core/tenant-access';
import {
  federationSignInStartSchema,
  federationTestStartSchema,
} from '@pertexo/contracts';

import { requireDoubleSubmitCsrf } from '../../better-auth/csrf.js';

import { failure } from './reply.js';

export type BrowserSession = Readonly<{ userId: string; sessionId: string }>;

type OrganizationStartMaterial = Readonly<{
  material: Awaited<ReturnType<OrganizationSignInCommands['provider']>>;
  owner: BrowserSession | undefined;
  returnPath: string;
}>;

export async function prepareOrganizationStart(
  request: Request,
  raw: unknown,
  input: Readonly<{
    testing: boolean;
    commands: OrganizationSignInCommands;
    authenticate(request: Request): Promise<BrowserSession | undefined>;
  }>,
): Promise<OrganizationStartMaterial | Response> {
  const { testing } = input;
  let material: Awaited<ReturnType<OrganizationSignInCommands['provider']>>;
  let owner: BrowserSession | undefined;
  let returnPath = '/workspaces';
  if (testing) {
    try {
      requireDoubleSubmitCsrf(request.headers);
    } catch {
      return failure(403);
    }
    const parsed = federationTestStartSchema.safeParse(raw);
    if (!parsed.success) return failure(400);
    owner = await input.authenticate(request);
    if (owner === undefined) return failure(401);
    try {
      material = await input.commands.testProvider({
        ...parsed.data,
        actorId: owner.userId,
      });
    } catch (cause: unknown) {
      if (
        cause instanceof FederationConflictError ||
        cause instanceof WorkspaceAccessDeniedError
      )
        return failure(403);
      throw cause;
    }
    returnPath = `/w/${parsed.data.workspaceId}/settings/sso`;
  } else {
    const parsed = federationSignInStartSchema.safeParse(raw);
    if (!parsed.success) return failure(400);
    material = await input.commands.provider(
      parsed.data.providerId,
      parsed.data.domain,
    );
    returnPath = parsed.data.returnPath ?? returnPath;
  }

  return { material, owner, returnPath };
}
