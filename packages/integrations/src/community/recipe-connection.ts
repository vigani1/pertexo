import { Buffer } from 'node:buffer';
import type { ParsedConnectionCredential } from '@pertexo/contracts';
import { withProviderCredential } from '@pertexo/node-sdk/server';
import type { ConnectionDefinition } from '../providers/connection-definition.js';
import type { RequestConnectionBinding } from '../http/request/execution/invocation.js';
import { refuseHttpCredential } from '../http/request/execution/credentials.js';
import type { CommunityConnection } from './manifest.schemas.js';

const COMMUNITY_CREDENTIAL_PURPOSE = 'community.recipe.execute';

export function recipeConnection(
  providerKey: string,
  definition: ConnectionDefinition,
  auth: CommunityConnection['auth'],
): RequestConnectionBinding {
  const { authType, schema, slot } = definition;
  return {
    providerKey,
    slot: slot.key,
    resolve: (connections, input) =>
      connections.resolve({
        ...input,
        expectedProviderKey: providerKey,
        expectedAuthType: slot.key,
        purpose: COMMUNITY_CREDENTIAL_PURPOSE,
      }),
    withHeaders(resolved, connectionId, run) {
      if ('accessToken' in resolved)
        throw refuseHttpCredential('configuration');
      return withProviderCredential(
        resolved,
        {
          connectionId,
          providerKey,
          authTypes: [authType],
          schema,
          refuse: refuseHttpCredential,
        },
        (credential) => run(recipeAuth(auth, credential)),
      );
    },
  };
}

function recipeAuth(
  auth: CommunityConnection['auth'],
  credential: ParsedConnectionCredential,
) {
  // The manifest checks the references and the connection schema parses each field.
  const fields = credential as Readonly<Record<string, string>>;
  if (auth.kind === 'basic') {
    const username = fields[auth.username]!;
    const password = fields[auth.password]!;
    const bytes = Buffer.from(`${username}:${password}`);
    try {
      const encoded = bytes.toString('base64');
      return {
        headers: { authorization: `Basic ${encoded}` },
        sensitiveValues: [username, password, encoded],
      };
    } finally {
      bytes.fill(0);
    }
  }
  const value = fields[auth.field]!;
  const headers =
    auth.kind === 'bearer'
      ? { authorization: `Bearer ${value}` }
      : { [auth.name.toLowerCase()]: value };
  return { headers, sensitiveValues: [value] };
}
