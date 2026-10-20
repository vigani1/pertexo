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
  try {
    await client.query('BEGIN');
    response = await handle(client, (deliver) => deliveries.push(deliver));
    // Better Auth converts internal exceptions into HTTP errors. Never commit
    // a partial session, consumed recovery code or disabled factor on a 5xx.
    // Commit 4xx refusals so wrong codes still consume the SDK lockout budget.
    await client.query(response.status >= 500 ? 'ROLLBACK' : 'COMMIT');
    if (response.status >= 500) {
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
  if (response.status < 500)
    await Promise.allSettled(
      deliveries.map((deliver) => Promise.resolve().then(deliver)),
    );
  return response;
}
