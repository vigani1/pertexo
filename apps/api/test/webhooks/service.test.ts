import { describe } from 'vitest';

import { registerPassesHashesSealedSecretsPersistenceDiscloses } from './service/passes-hashes-sealed-secrets-persistence-discloses.cases.js';
import { registerOperationDisclosesExactlyOriginalCredentialsWipes } from './service/operation-discloses-exactly-original-credentials-wipes.cases.js';
describe('webhook management service', () => {
  registerPassesHashesSealedSecretsPersistenceDiscloses();

  registerOperationDisclosesExactlyOriginalCredentialsWipes();
});
