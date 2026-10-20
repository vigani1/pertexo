import { withPlatformTransaction } from '@pertexo/database/platform';
import { TWO_FACTOR_ERROR_CODES } from 'better-auth/plugins/two-factor';
import { isRecord } from '@pertexo/workflow-model';
import type { Pool, PoolClient } from 'pg';

const securityMutationPaths = new Set([
  '/two-factor/verify-backup-code',
  '/two-factor/disable',
]);

export function isSecurityMutationPath(path: string): boolean {
  return securityMutationPaths.has(path);
}

/** Only these SDK routes need Pertexo's fact and durable notice in the same commit. */
export function needsSecurityTransaction(request: Request): boolean {
  const path = new URL(request.url).pathname.replace(/\/+$/u, '');
  return (
    request.method === 'POST' &&
    path.startsWith('/v1/auth/') &&
    isSecurityMutationPath(path.slice('/v1/auth'.length))
  );
}

// These refusals happen before code consumption/session creation. Their writes
// are the SDK's lockout budget, which must survive an incorrect-code response.
const lockoutRefusals = new Map<string, number>([
  [TWO_FACTOR_ERROR_CODES.INVALID_BACKUP_CODE.code, 401],
  [TWO_FACTOR_ERROR_CODES.TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE.code, 400],
  [TWO_FACTOR_ERROR_CODES.ACCOUNT_TEMPORARILY_LOCKED.code, 429],
]);

async function isLockoutRefusal(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.clone().json();
    return (
      isRecord(body) &&
      typeof body.code === 'string' &&
      lockoutRefusals.get(body.code) === response.status
    );
  } catch {
    return false;
  }
}

class RefusedSecurityMutation extends Error {
  constructor(readonly response: Response) {
    super('Security mutation refused');
  }
}

export async function securityTransaction(
  pool: Pool,
  handle: (
    client: PoolClient,
    afterCommit: (deliver: () => Promise<void>) => void,
  ) => Promise<Response>,
): Promise<Response> {
  const deliveries: (() => Promise<void>)[] = [];
  let response: Response;
  try {
    response = await withPlatformTransaction(pool, async (client) => {
      const result = await handle(client, (deliver) =>
        deliveries.push(deliver),
      );
      // A policy refusal can follow SDK writes. Preserve only successful changes
      // or explicit pre-mutation lockout refusals; the database owns rollback.
      if (!result.ok && !(await isLockoutRefusal(result)))
        throw new RefusedSecurityMutation(result);
      return result;
    });
  } catch (error) {
    if (!(error instanceof RefusedSecurityMutation)) throw error;
    const headers = new Headers(error.response.headers);
    headers.delete('set-cookie');
    return new Response(error.response.body, {
      status: error.response.status,
      headers,
    });
  }
  // Only the development/test sink uses callbacks. Production mail commands
  // were inserted above; SMTP delivery runs independently after the commit.
  await Promise.allSettled(
    deliveries.map((deliver) => Promise.resolve().then(deliver)),
  );
  return response;
}
