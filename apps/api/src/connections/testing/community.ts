import { CONNECTION_TEST_TIMEOUT_MILLIS } from '@pertexo/contracts';
import {
  executeCommunityConnectionTest,
  type ConnectionDefinition,
} from '@pertexo/integrations/server';
import { ConnectionSecretEncryptionError } from '@pertexo/secrets/server';
import type { ConnectionDependencies } from '../ports.js';
import { responseOutcome } from './outcomes.js';

export async function testCommunityConnection(
  client: ConnectionDependencies['communityHttpClient'],
  definition: ConnectionDefinition,
  input: Omit<
    Parameters<typeof executeCommunityConnectionTest>[2],
    'timeoutMillis'
  >,
) {
  if (client === undefined) throw new ConnectionSecretEncryptionError();
  return responseOutcome(
    await executeCommunityConnectionTest(client, definition, {
      ...input,
      timeoutMillis: CONNECTION_TEST_TIMEOUT_MILLIS,
    }),
  );
}
