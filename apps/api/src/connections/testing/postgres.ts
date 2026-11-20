import { POSTGRES_LIMITS, type PostgresCredential } from '@pertexo/contracts';
import {
  createSecurePostgresClient,
  type AllowedPrivateNetwork,
} from '@pertexo/secrets/server';
import type { ConnectionTestOutcome } from '@pertexo/workflow-model';
import { SUCCEEDED_TEST } from './outcomes.js';
import { CONNECTION_TEST_TIMEOUT_MILLIS } from '@pertexo/contracts';

export async function testPostgresConnection(
  credential: PostgresCredential,
  allowedPrivateNetworks: readonly AllowedPrivateNetwork[],
  input: Readonly<{ signal: AbortSignal; beforeDispatch(): Promise<void> }>,
): Promise<ConnectionTestOutcome> {
  const outcome = await createSecurePostgresClient(
    allowedPrivateNetworks,
  ).execute(
    { ...credential, readOnly: true },
    {
      ...input,
      timeoutMillis: CONNECTION_TEST_TIMEOUT_MILLIS,
      maxRows: POSTGRES_LIMITS.defaultRows,
    },
    (session) => session.query('select 1'),
  );
  return outcome.kind === 'succeeded'
    ? SUCCEEDED_TEST
    : {
        ok: false,
        httpStatus: null,
        errorCode: `database.${outcome.code}`,
        reauthorizationRequired: outcome.code === 'authentication_failed',
      };
}
