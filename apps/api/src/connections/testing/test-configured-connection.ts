import { hasCredentialType } from '../credential-type.js';
import { testHttpConnection } from './http.js';
import { requestInputError } from '../../platform/http/request-input.js';
import { testDestination } from './test-destination.js';
import { testPostgresConnection } from './postgres.js';
import type { FailureNotificationDestinationResponse } from '@pertexo/contracts';
import {
  CONNECTION_TEST_TIMEOUT_MILLIS,
  postgresCredentialSchema,
  smtpCredentialSchema,
} from '@pertexo/contracts';
import type { ConnectionTestOutcome } from '@pertexo/workflow-model';
import { ConnectionSecretEncryptionError } from '@pertexo/secrets/server';
import type { ConnectionDependencies } from '../ports.js';
import type { decodeCredential } from './credentials.js';
import type { TestConnectionCommand } from './test-connection.js';
import { SUCCEEDED_TEST } from './outcomes.js';
import * as smtp from './smtp.js';

type ParsedConnectionTestRequest = TestConnectionCommand['request'];
type DecodedConnectionCredential = ReturnType<typeof decodeCredential>;

export const CONNECTION_TEST_MAXIMUM_REDIRECTS = 3;
export const CONNECTION_TEST_MAXIMUM_RESPONSE_BYTES = 65_536;

export async function testConfiguredConnection(
  dependencies: Pick<
    ConnectionDependencies,
    'smtpPolicy' | 'emailClient' | 'slackClient' | 'httpClient'
  >,
  destination: FailureNotificationDestinationResponse | undefined,
  {
    request,
    credential,
    recipe,
    auth,
    input,
    signal,
    beforeDispatch,
  }: Readonly<{
    request: ParsedConnectionTestRequest;
    credential: DecodedConnectionCredential['credential'];
    recipe: DecodedConnectionCredential['recipe'];
    auth: DecodedConnectionCredential['auth'];
    input: TestConnectionCommand;
    signal: AbortSignal;
    beforeDispatch: () => Promise<void>;
  }>,
): Promise<ConnectionTestOutcome> {
  if (
    recipe.kind === 'postgres' &&
    hasCredentialType(credential, postgresCredentialSchema)
  )
    return testPostgresConnection(
      credential,
      dependencies.smtpPolicy?.allowedPrivateNetworks ?? [],
      {
        signal,
        beforeDispatch,
      },
    );
  if (
    recipe.kind === 'smtp' &&
    hasCredentialType(credential, smtpCredentialSchema)
  ) {
    smtp.assertSmtpTestProfile(request, destination);
    return smtp.testSmtpConnection(credential, dependencies.smtpPolicy, {
      command: input,
      destination,
      timeoutMillis: CONNECTION_TEST_TIMEOUT_MILLIS,
      signal,
      beforeDispatch,
    });
  }
  if (
    recipe.kind === 'http' &&
    recipe.requiresConsent === true &&
    !('sideEffectDisclosureAccepted' in request)
  )
    throw requestInputError(['transport'], recipe.consentMessage);
  if (destination !== undefined)
    return testDestination(
      { email: dependencies.emailClient, slack: dependencies.slackClient },
      destination,
      credential,
      { command: input, signal, beforeDispatch },
    );
  if (
    recipe.kind === 'signing' &&
    credential.type === 'hmac_key' &&
    'providerKey' in request &&
    request.providerKey === 'signing'
  ) {
    await beforeDispatch();
    return SUCCEEDED_TEST;
  }
  if (recipe.kind !== 'http') throw new ConnectionSecretEncryptionError();
  return testHttpConnection(dependencies.httpClient, {
    request,
    credential,
    recipe,
    auth,
    command: input,
    timeoutMillis: CONNECTION_TEST_TIMEOUT_MILLIS,
    maxRedirects: CONNECTION_TEST_MAXIMUM_REDIRECTS,
    maxResponseBytes: CONNECTION_TEST_MAXIMUM_RESPONSE_BYTES,
    signal,
    beforeDispatch,
  });
}
