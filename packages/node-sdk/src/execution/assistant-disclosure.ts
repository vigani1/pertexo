import type {
  SchemaDocument,
  SchemaJson,
} from '../definitions/schema-document.js';
import type { NodeDefinitionRegistration } from './node-execution.types.js';
import { NodeRegistryCompatibilityError } from './node-execution.errors.js';

/**
 * What the authoring assistant may read and edit of one record (a step's
 * config or its input mappings). Each top-level field is named exactly once.
 */
export interface AssistantFields {
  readonly visible: readonly string[];
  readonly masked: readonly string[];
  /** Visible unless `isMaskedAddress` says otherwise. */
  readonly addresses?: readonly string[];
  /** How to treat names an open schema accepts beyond the listed ones. */
  readonly unlisted?: 'visible' | 'masked';
}

export interface AssistantDisclosure {
  readonly config: AssistantFields;
  readonly inputs: AssistantFields;
}

// Webhook and bot tokens (Slack, Discord, Teams, Telegram) sit in the path as
// one long segment that mixes letters and digits. A UUID matches too, which
// only over-protects.
const SECRET_PATH_SEGMENT = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_:-]{20,}$/u;

/**
 * Whether an address must be masked whole: it has user information, a query
 * string, or a path segment that looks like a secret token. Ordinary paths
 * such as `/v2/orders` stay visible. Anything but a string is masked.
 */
export function isMaskedAddress(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  if (value.includes('?')) return true;
  const [, authority = '', path = value] =
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/#]*)([^#]*)/u.exec(value) ?? [];
  if (authority.includes('@')) return true;
  return path.split('/').some((segment) => SECRET_PATH_SEGMENT.test(segment));
}

/**
 * Refuse a declaration that leaves a top-level field unclassified, names one
 * the schema lacks or names one twice, so no field becomes visible by
 * accident. A registration without a declaration stays fully masked.
 */
export function validateAssistantDisclosure({
  manifest,
  assistantDisclosure,
}: NodeDefinitionRegistration): void {
  if (assistantDisclosure === undefined) return;
  const { key, version } = manifest.definition;
  const identity = `${key}@${String(version)}`;
  for (const [kind, schema] of [
    ['config', manifest.configSchema],
    ['inputs', manifest.inputSchema],
  ] as const) {
    const { names, open } = schemaFields(schema);
    const fields = assistantDisclosure[kind];
    for (const field of [
      ...fields.visible,
      ...fields.masked,
      ...(fields.addresses ?? []),
    ])
      if (!names.delete(field))
        throw new NodeRegistryCompatibilityError(
          `Assistant disclosure for ${identity} names an unknown or repeated ${kind} field: ${field}`,
        );
    const [unclassified] = names;
    if (unclassified !== undefined)
      throw new NodeRegistryCompatibilityError(
        `Assistant disclosure for ${identity} does not classify the ${kind} field: ${unclassified}`,
      );
    if ((fields.unlisted !== undefined) !== open)
      throw new NodeRegistryCompatibilityError(
        open
          ? `Assistant disclosure for ${identity} must classify unlisted ${kind} fields`
          : `Assistant disclosure for ${identity} names unlisted ${kind} fields on a closed schema`,
      );
  }
}

/** Only top-level properties are classified, including those in a union branch. */
function schemaFields(schema: SchemaDocument) {
  const names = new Set(Object.keys(objectSchema(schema.properties) ?? {}));
  let open =
    schema.additionalProperties === true ||
    objectSchema(schema.additionalProperties) !== undefined;
  for (const composition of [schema.anyOf, schema.oneOf, schema.allOf]) {
    if (!Array.isArray(composition)) continue;
    for (const value of composition as readonly SchemaJson[]) {
      const branch = objectSchema(value);
      if (branch === undefined) continue;
      const fields = schemaFields(branch);
      for (const name of fields.names) names.add(name);
      open ||= fields.open;
    }
  }
  return { names, open };
}

function objectSchema(
  value: SchemaJson | undefined,
): SchemaDocument | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value))
    return value as SchemaDocument;
  return undefined;
}
