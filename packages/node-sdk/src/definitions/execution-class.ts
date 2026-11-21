import { z } from 'zod';
import type { NodeManifest } from './catalog.js';
import { NodeCatalogIntegrityError } from './catalog.errors.js';
import { identityToken } from './identity.js';

// Keep the field optional for legacy manifests, whose class is attempt.
export const executionClassSchema = z.enum(['attempt', 'inline']);

/** Refuse inline declarations from sources that can only register attempts. */
export function assertAttemptOnlyManifest(
  manifest: Pick<NodeManifest, 'definition' | 'execution'>,
): void {
  if (manifest.execution === 'inline')
    throw new NodeCatalogIntegrityError(
      `definition ${identityToken(manifest.definition)}: inline execution requires a core registration`,
    );
}
