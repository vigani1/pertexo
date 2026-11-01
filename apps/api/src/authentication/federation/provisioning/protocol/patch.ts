import { DIRECTORY_LIMITS, canonicalEmail } from '@pertexo/workflow-model';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  scimPatch,
  patchBodyValidation,
  NoTarget,
  type ScimPatchOperation,
} from 'scim-patch';
import { DirectoryError } from '@pertexo/core/identity';
import {
  canonicalDocument,
  canonicalPath,
  type DirectoryResourceType,
} from './core.js';
import { parseDirectoryFilter } from './filter.js';

const operationSchema = z
  .object({
    op: z
      .string()
      .toLowerCase()
      .pipe(z.enum(['add', 'replace', 'remove'])),
    path: z.string().min(1).max(1024).optional(),
    value: z.unknown().optional(),
  })
  .strict();
const patchSchema = z
  .object({
    schemas: z.tuple([
      z.literal('urn:ietf:params:scim:api:messages:2.0:PatchOp'),
    ]),
    Operations: z
      .array(operationSchema)
      .min(1)
      .max(DIRECTORY_LIMITS.patchOperations),
  })
  .strict();
type Resource = Readonly<{
  schemas: readonly string[];
  id: string;
  groups?: unknown;
  meta: Readonly<{ created: string; lastModified: string }>;
}>;

export function parseDirectoryPatch(
  input: unknown,
  kind: DirectoryResourceType,
): readonly ScimPatchOperation[] {
  try {
    const body = patchSchema.parse(canonicalDocument(input));
    const Operations = body.Operations.map((operation): ScimPatchOperation => {
      const path =
        operation.path === undefined
          ? undefined
          : canonicalPath(operation.path, kind);
      if (path !== undefined) {
        // The patch SDK owns path grammar. Its embedded filter gets the same budgets as a list query.
        const first = path.indexOf('['),
          last = path.lastIndexOf(']');
        if (first >= 0) parseDirectoryFilter(path.slice(first + 1, last));
      }
      if (operation.op === 'remove') {
        if (path === undefined) throw new DirectoryError('invalid_path');
        return {
          op: 'remove',
          path,
          ...(Object.hasOwn(operation, 'value')
            ? { value: operation.value }
            : {}),
        };
      }
      if (!Object.hasOwn(operation, 'value'))
        throw new DirectoryError('invalid_value');
      return {
        op: operation.op,
        ...(path === undefined ? {} : { path }),
        value: operation.value,
      };
    });
    patchBodyValidation({ schemas: body.schemas, Operations });
    return Operations;
  } catch (error: unknown) {
    if (error instanceof DirectoryError) throw error;
    throw new DirectoryError('invalid_value');
  }
}
export function applyDirectoryPatch(
  current: Resource,
  operations: readonly ScimPatchOperation[],
): unknown {
  try {
    const patched = scimPatch(
      {
        ...current,
        schemas: [...current.schemas],
        meta: {
          ...current.meta,
          created: new Date(current.meta.created),
          lastModified: new Date(current.meta.lastModified),
        },
      },
      [],
      { mutateDocument: false, treatMissingAsAdd: false },
    );
    for (const operation of operations) {
      const before = new Set(
        primaryEmails(patched).map((email) => email.value),
      );
      // This clone belongs to this request. A later failure discards every earlier edit.
      scimPatch(patched, [operation], {
        mutateDocument: true,
        treatMissingAsAdd: false,
      });
      const primary = primaryEmails(patched);
      const promoted = primary.filter((email) => !before.has(email.value));
      if (promoted.length > 1) throw new DirectoryError('invalid_value');
      if (promoted.length === 1)
        for (const email of primary)
          Reflect.set(email.record, 'primary', email === promoted[0]);
      // Schema coercion intentionally drops read-only input; check before it can do so.
      for (const name of ['id', 'meta', 'schemas', 'groups'])
        if (
          !isDeepStrictEqual(
            Reflect.get(current, name),
            Reflect.get(patched, name),
          )
        )
          throw new DirectoryError('mutability');
    }
    return patched;
  } catch (error: unknown) {
    if (error instanceof DirectoryError) throw error;
    if (error instanceof NoTarget) throw new DirectoryError('no_target');
    throw new DirectoryError('invalid_path');
  }
}

/** RFC 7644 makes selecting a new primary clear the other primary flags. */
function primaryEmails(
  resource: object,
): readonly Readonly<{ value: string; record: object }>[] {
  const emails: unknown = Reflect.get(resource, 'emails');
  if (!Array.isArray(emails)) return [];
  return emails.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const value: unknown = Reflect.get(entry, 'value');
    return typeof value === 'string' && Reflect.get(entry, 'primary') === true
      ? [{ value: canonicalEmail(value), record: entry }]
      : [];
  });
}
