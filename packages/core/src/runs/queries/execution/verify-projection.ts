import { createHash } from 'node:crypto';
import {
  canonicalJson,
  normalizedJson,
  utf8ByteLength,
} from '@pertexo/workflow-model';
import { decodeStoredValue } from '../../../shared/stored-values.js';
import type { PublishedWorkflow } from './workflow-execution.types.js';
import { verifyWorkflowExecutable } from '@pertexo/workflow-engine';

/** The served catalog (node catalog plus engine policies) stored executables run on. */
export type PersistedWorkflowProjectionVerificationOptions = Readonly<{
  catalog: unknown;
}>;

type Verified = ReturnType<typeof verifyWorkflowExecutable>;
const verifiedProjections = new Map<
  string,
  Readonly<{ value: Verified; bytes: number }>
>();
const maximumEntries = 64;
const maximumBytes = 16 * 1024 * 1024;
let retainedBytes = 0;

/** Verifies once per immutable content/catalog identity, including fresh database reads. */
export function verifyPersistedWorkflowProjection(
  projection: PublishedWorkflow,
  options: PersistedWorkflowProjectionVerificationOptions,
): Verified {
  return decodeStoredValue(() => {
    // Validate JSON while preserving authored member order. JSON.stringify
    // would erase invalid values (NaN or undefined) before the identity check.
    const content = normalizedJson(projection.executableJson);
    const catalog = canonicalJson(options.catalog);
    const key = JSON.stringify([
      projection.workspaceId,
      projection.workflowId,
      projection.id,
      projection.checksum,
      createHash('sha256').update(content).digest('hex'),
      createHash('sha256').update(catalog).digest('hex'),
    ]);
    const existing = verifiedProjections.get(key);
    if (existing !== undefined) {
      verifiedProjections.delete(key);
      verifiedProjections.set(key, existing);
      return existing.value;
    }
    const value = verifyWorkflowExecutable({
      envelope: projection.executableJson,
      checksum: projection.checksum,
      catalog: options.catalog,
    });
    const bytes = utf8ByteLength(content) + utf8ByteLength(catalog);
    if (bytes <= maximumBytes) {
      while (
        verifiedProjections.size >= maximumEntries ||
        retainedBytes + bytes > maximumBytes
      ) {
        const oldest = verifiedProjections.entries().next().value;
        if (oldest === undefined) break;
        verifiedProjections.delete(oldest[0]);
        retainedBytes -= oldest[1].bytes;
      }
      verifiedProjections.set(key, { value, bytes });
      retainedBytes += bytes;
    }
    return value;
  });
}
