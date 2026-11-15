import { useLatestCommand } from '@/lib/api/commands/use-latest-command';
import {
  readSamlMetadata,
  type FederationScope,
} from './federation-settings.api';

/**
 * The service-provider metadata an identity provider imports, as the file
 * it is saved as. Only the bounded public metadata the API returned.
 */
async function readSamlMetadataFile(
  scope: FederationScope,
  signal: AbortSignal,
) {
  const metadata = await readSamlMetadata(scope, signal);
  return {
    name: 'pertexo-saml.xml',
    type: 'application/samlmetadata+xml',
    text: metadata.xml,
  };
}

/** Reads the metadata file to save. */
export function useSamlMetadataFile(scope: FederationScope) {
  return useLatestCommand((_: null, signal: AbortSignal) =>
    readSamlMetadataFile(scope, signal),
  );
}
