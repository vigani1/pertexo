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

export async function securityTransaction(
  pool: Pool,
  handle: (
    client: PoolClient,
    afterCommit: (deliver: () => Promise<void>) => void,
  ) => Promise<Response>,
): Promise<Response> {
  const client = await pool.connect();
  const deliveries: (() => Promise<void>)[] = [];
  let response: Response;
  let committed = false;
  try {
    await client.query('BEGIN');
    response = await handle(client, (deliver) => deliveries.push(deliver));
    // A policy refusal can happen after the SDK changes credentials. Commit
    // successful responses or the explicit pre-mutation lockout refusals only.
    const commit = response.ok || (await isLockoutRefusal(response));
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    committed = commit;
    if (!commit) {
      const headers = new Headers(response.headers);
      headers.delete('set-cookie');
      response = new Response(response.body, {
        status: response.status,
        headers,
      });
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  // Only the development/test sink uses callbacks. Production mail commands
  // were inserted above; SMTP delivery runs independently after the commit.
  if (committed)
    await Promise.allSettled(
      deliveries.map((deliver) => Promise.resolve().then(deliver)),
    );
  return response;
}
