import {
  findConnectionDefinition,
  isRegisteredProvider,
} from '@pertexo/node-catalog';
import { z } from 'zod';
import {
  parseRequestInput,
  requestInputError,
} from '../../platform/http/request-input.js';

type CredentialEnvelope = Readonly<{ type: string }>;

export function admitConnectionCreate(
  body: Readonly<{
    providerKey: string;
    name: string;
    credential: CredentialEnvelope;
  }>,
) {
  const { providerKey, name, credential } = body;
  const definition = findConnectionDefinition(credential.type, providerKey);
  if (definition === undefined)
    throw requestInputError(
      isRegisteredProvider(providerKey)
        ? ['credential', 'type']
        : ['providerKey'],
      'Connection provider and credential type are not registered together',
    );
  return {
    providerKey: definition.providerKey,
    name,
    credential: parseCredential(definition, credential),
  };
}

export function admitConnectionRotation(
  body: Readonly<{
    expectedSecretVersionId: string;
    credential: CredentialEnvelope;
  }>,
) {
  const definition = findConnectionDefinition(body.credential.type);
  if (definition === undefined)
    throw requestInputError(
      ['credential', 'type'],
      'Connection credential type is not registered',
    );
  return {
    expectedSecretVersionId: body.expectedSecretVersionId,
    expectedProviderKey: definition.providerKey,
    credential: parseCredential(definition, body.credential),
  };
}

function parseCredential(
  definition: NonNullable<ReturnType<typeof findConnectionDefinition>>,
  credential: CredentialEnvelope,
) {
  return parseRequestInput(z.object({ credential: definition.schema }), {
    credential,
  }).credential;
}
