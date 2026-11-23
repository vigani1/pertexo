import { ProviderCredentialRejectedError } from '@pertexo/integrations/server';
import { ConnectionSecretEncryptionError } from '@pertexo/secrets/server';
import type { ConnectionTestOutcome } from '@pertexo/workflow-model';
import { isApplicationError } from '../../platform/http/application-error.js';
import type { LookupConnectionOptionsService } from '../lookups/lookup-options.service.js';
import { credentialRejectedOutcome, SUCCEEDED_TEST } from './outcomes.js';

export async function testConnectionLookup(
  lookup: LookupConnectionOptionsService | undefined,
  input: Parameters<LookupConnectionOptionsService['execute']>[0],
  test: NonNullable<Parameters<LookupConnectionOptionsService['execute']>[1]>,
): Promise<ConnectionTestOutcome> {
  if (lookup === undefined) throw new ConnectionSecretEncryptionError();
  try {
    await lookup.execute(input, test);
    return SUCCEEDED_TEST;
  } catch (error: unknown) {
    if (error instanceof ProviderCredentialRejectedError)
      return credentialRejectedOutcome(error.status);
    if (!isApplicationError(error) || error.code !== 'provider.unavailable')
      throw error;
    return {
      ok: false,
      httpStatus: null,
      errorCode: 'connection.provider_invalid_response',
      reauthorizationRequired: false,
    };
  }
}
