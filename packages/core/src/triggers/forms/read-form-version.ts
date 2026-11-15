import type { PoolClient } from 'pg';
import { readFormDefinition } from './read-form-definition.js';
import { FormUnavailableError } from './form.errors.js';
import type { FormScope } from './form-admission.types.js';
import {
  lockPublishedVersionId,
  readPublishedVersion,
} from './form-versions.repository.js';

/** The caller has already decided who is asking and which workspace statuses count. */
export async function readFormVersion(
  client: PoolClient,
  input: FormScope,
  locking: 'read' | 'share' | 'update',
  { allowPaused = false }: Readonly<{ allowPaused?: boolean | undefined }> = {},
) {
  // Lock before reading the version: a locked join waiting on a concurrent
  // publication re-checks against the old version row and finds no form.
  const publishedVersionId = await lockPublishedVersionId(
    client,
    input,
    locking,
    allowPaused,
  );
  if (publishedVersionId === undefined || publishedVersionId === null)
    throw new FormUnavailableError();
  const row = await readPublishedVersion(client, input, publishedVersionId);
  if (row === undefined) throw new FormUnavailableError();
  return {
    version: Object.freeze(row.version),
    ...readFormDefinition(row.graphJson),
  };
}
