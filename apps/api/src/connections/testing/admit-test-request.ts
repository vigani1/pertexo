import type { ConnectionTestRequest } from '@pertexo/contracts';
import { connectionFormCatalog } from '@pertexo/node-catalog';
import { requestInputError } from '../../platform/http/request-input.js';

export function admitConnectionTestRequest(body: ConnectionTestRequest) {
  if ('url' in body) return body;
  // Dispatch for community recipes is introduced with the secure HTTP path in slice 2.
  if (body.providerKey.startsWith('community.'))
    throw requestInputError([], 'Community connection tests are not available');
  const supported = connectionFormCatalog().some((definition) => {
    if (definition.providerKey !== body.providerKey) return false;
    if ('transport' in body) return definition.test === body.transport;
    if ('sideEffectDisclosureAccepted' in body)
      return definition.testInput === 'consent';
    return definition.testInput === 'provider' && definition.test !== 'smtp';
  });
  if (!supported) throw requestInputError([], 'Invalid input');
  return body;
}
