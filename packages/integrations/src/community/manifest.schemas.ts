import {
  CONNECTION_PROVIDER_KEY_PATTERN,
  NODE_IDENTITY_KEY_MAX_CHARACTERS,
} from '@pertexo/node-sdk';
import {
  hostReleaseCompatibility,
  PERTEXO_HOST_RELEASE,
} from '@pertexo/node-sdk/server';
import { httpHeadersCredentialSchema } from '@pertexo/contracts';
import { z } from 'zod';
import { decodeCommunityJson } from './decode-json.js';
import { CommunityManifestError } from './manifest.errors.js';
import { COMMUNITY_MANIFEST_LIMITS as limits } from './manifest-limits.js';

export const COMMUNITY_FORMAT_VERSION = 1;

const text = z.string().min(1).max(limits.stringCharacters);
// oxlint-disable-next-line eslint/no-control-regex -- Presentation is printable plain text.
const title = text.regex(/^[^<>\u0000-\u001f\u007f]+$/u);
const fieldKey = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/u)
  .refine((key) => key !== 'constructor' && key !== 'prototype');
const slug = z.string().regex(/^[a-z0-9]+$/u);
const providerKey = z
  .string()
  .max(NODE_IDENTITY_KEY_MAX_CHARACTERS)
  .regex(CONNECTION_PROVIDER_KEY_PATTERN);
const versionPart = '(?:0|[1-9][0-9]*)';
const prereleasePart = '(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)';
const releaseVersion = z
  .string()
  .max(limits.versionCharacters)
  .regex(
    new RegExp(
      `^${versionPart}\\.${versionPart}\\.${versionPart}(?:-${prereleasePart}(?:\\.${prereleasePart})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`,
      'u',
    ),
  );

export function isCommunityOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

const schemaField = z.strictObject({
  type: z.enum(['string', 'number', 'integer', 'boolean']),
  required: z.boolean(),
});
const credentialField = z.strictObject({
  label: title,
  kind: z.enum(['text', 'secret']),
  default: text.optional(),
});
const boundedFields = <T extends z.ZodType>(schema: T) =>
  z
    .record(fieldKey, schema)
    .refine((value) => Object.keys(value).length <= limits.fields);
const inputReference = z.strictObject({ input: fieldKey });
const inputsByName = boundedFields(inputReference);
const auth = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('bearer'), field: fieldKey }),
  z.strictObject({
    kind: z.literal('named_header'),
    field: fieldKey,
    name: text,
  }),
  z.strictObject({
    kind: z.literal('basic'),
    username: fieldKey,
    password: fieldKey,
  }),
]);
const connection = z.strictObject({
  fields: boundedFields(credentialField),
  auth,
  test: z.strictObject({ method: z.enum(['GET', 'HEAD']), path: text }),
});
const operation = z.strictObject({
  key: slug.max(NODE_IDENTITY_KEY_MAX_CHARACTERS),
  name: title.max(NODE_IDENTITY_KEY_MAX_CHARACTERS),
  description: title,
  input: boundedFields(schemaField),
  output: boundedFields(schemaField),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: text,
  query: inputsByName.optional(),
  body: inputsByName.optional(),
  projection: z.union([z.literal('body'), boundedFields(text)]),
  sideEffect: z.enum(['safe', 'unsafe']),
  connection: z.literal('connection').optional(),
});
const manifest = z.strictObject({
  format: z.literal(COMMUNITY_FORMAT_VERSION),
  publisher: slug,
  integration: slug,
  version: releaseVersion,
  hostRelease: z.strictObject({
    min: z.string().max(limits.versionCharacters),
    below: z.string().max(limits.versionCharacters),
  }),
  presentation: z.strictObject({
    name: title.max(NODE_IDENTITY_KEY_MAX_CHARACTERS),
    description: title,
    icon: z.enum([
      'key',
      'sparkles',
      'globe',
      'hash',
      'mail',
      'database',
      'webhook',
    ]),
  }),
  origin: text.refine(isCommunityOrigin),
  actions: z.array(operation).min(1).max(limits.actions),
  connection: connection.optional(),
});

export type CommunityManifest = z.output<typeof manifest>;
export type CommunityAction = z.output<typeof operation>;
export type CommunityConnection = z.output<typeof connection>;
export type CommunitySchemaField = z.output<typeof schemaField>;

export function decodeCommunityManifest(bytes: Uint8Array): CommunityManifest {
  const result = manifest.safeParse(decodeCommunityJson(bytes));
  if (!result.success)
    throw new CommunityManifestError(z.prettifyError(result.error));
  const release = result.data;
  const key = communityProviderKey(release);
  const compatibility = hostReleaseCompatibility(release.hostRelease);
  if (compatibility !== 'compatible') {
    const { min, below } = release.hostRelease;
    throw new CommunityManifestError(
      `${key}@${release.version} has ${compatibility} host range [${min}, ${below}) for host ${PERTEXO_HOST_RELEASE}`,
    );
  }

  if (release.connection !== undefined) validateConnection(release.connection);
  const operations = new Set<string>();
  for (const action of release.actions) {
    if (operations.has(action.key))
      throw new CommunityManifestError(`duplicate action ${action.key}`);
    operations.add(action.key);
    validateOperation(action, release.connection);
  }
  return release;
}

export function communityProviderKey(
  release: Pick<CommunityManifest, 'publisher' | 'integration'>,
): string {
  return providerKey.parse(
    `community.${release.publisher}.${release.integration}`,
  );
}

function validateConnection({
  auth: recipe,
  fields,
  test,
}: CommunityConnection) {
  validatePath(test.path, {});
  for (const [key, field] of Object.entries(fields)) {
    if (key === 'type')
      throw new CommunityManifestError('type is a reserved credential field');
    if (field.kind === 'secret' && field.default !== undefined)
      throw new CommunityManifestError(
        `secret default for credential field ${key}`,
      );
  }

  const requiredSecrets =
    recipe.kind === 'basic' ? [recipe.password] : [recipe.field];
  if (recipe.kind === 'basic' && !Object.hasOwn(fields, recipe.username))
    throw new CommunityManifestError(
      'Basic auth references a missing username field',
    );
  if (requiredSecrets.some((key) => fields[key]?.kind !== 'secret'))
    throw new CommunityManifestError(
      'auth references a missing or non-secret credential field',
    );
  if (
    recipe.kind === 'named_header' &&
    !httpHeadersCredentialSchema
      .unwrap()
      .shape.headers.safeParse({ [recipe.name]: 'value' }).success
  )
    throw new CommunityManifestError(
      'auth uses an invalid credential header name',
    );
}

function validateOperation(
  action: CommunityAction,
  credential?: CommunityConnection,
) {
  if (action.connection !== undefined && credential === undefined)
    throw new CommunityManifestError(
      `action ${action.key} references a missing connection slot`,
    );
  const safe = action.method === 'GET' || action.method === 'HEAD';
  if (
    safe !== (action.sideEffect === 'safe') ||
    (safe && action.body !== undefined)
  )
    throw new CommunityManifestError(
      `action ${action.key} has an incompatible method, effect or body`,
    );
  validatePath(action.path, action.input);
  for (const { input } of [
    ...Object.values(action.query ?? {}),
    ...Object.values(action.body ?? {}),
  ])
    if (!Object.hasOwn(action.input, input))
      throw new CommunityManifestError(
        `action ${action.key} references missing input ${input}`,
      );
  if (action.projection !== 'body') {
    for (const [output, pointer] of Object.entries(action.projection))
      if (
        !Object.hasOwn(action.output, output) ||
        !/^(?:\/(?:[^~/]|~[01])*)*$/u.test(pointer)
      )
        throw new CommunityManifestError(
          `action ${action.key} has an invalid output projection for ${output}`,
        );
  }
}

function validatePath(
  path: string,
  input: Readonly<Record<string, CommunitySchemaField>>,
) {
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new CommunityManifestError('path must be origin-relative');
  for (const segment of path.slice(1).split('/')) {
    const reference = pathInputName(segment);
    if (reference !== undefined) {
      if (
        !Object.hasOwn(input, reference) ||
        input[reference]?.required !== true
      )
        throw new CommunityManifestError(
          `path references missing or optional input ${reference}`,
        );
    } else if (
      !/^[a-zA-Z0-9._~-]*$/u.test(segment) ||
      segment === '.' ||
      segment === '..'
    ) {
      throw new CommunityManifestError('path contains an invalid segment');
    }
  }
}

export function pathInputName(segment: string): string | undefined {
  return /^\{([a-zA-Z][a-zA-Z0-9_]*)\}$/u.exec(segment)?.[1];
}
