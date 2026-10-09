import { z } from 'zod';

import {
  workflowGraphSchema,
  workflowGraphStructuralSchema,
  type WorkflowGraph,
} from '../graph/contract.js';
import { inspectWorkflowGraphAdmission } from '../graph/admission.js';

export const WORKFLOW_PORTABILITY_LIMITS = Object.freeze({
  bytes: 2_097_152,
  inputDepth: 256,
  requirements: 1_000,
  connectionSlots: 1_000,
  issues: 100,
});

export class PortableJsonError extends TypeError {
  public override readonly name = 'PortableJsonError';
  public constructor(
    public readonly code: 'portable_json_invalid' | 'portable_json_limit',
  ) {
    super('Portable JSON is invalid or exceeds its bounded contract');
  }
}

interface JsonFrame {
  object: boolean;
  keys: Set<string>;
  keyExpected: boolean;
}

/** Lexical inspection precedes JSON.parse, which would discard duplicate keys. */
function inspectJsonText(text: string): void {
  const stack: JsonFrame[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\') index += 1;
        index += 1;
      }
      if (index >= text.length)
        throw new PortableJsonError('portable_json_invalid');
      const current = stack.at(-1);
      if (current?.object === true && current.keyExpected) {
        const key: unknown = JSON.parse(text.slice(start, index + 1));
        if (typeof key !== 'string' || current.keys.has(key))
          throw new PortableJsonError('portable_json_invalid');
        current.keys.add(key);
        current.keyExpected = false;
      }
    } else if (character === '{' || character === '[') {
      stack.push({
        object: character === '{',
        keys: new Set(),
        keyExpected: true,
      });
      if (stack.length > WORKFLOW_PORTABILITY_LIMITS.inputDepth)
        throw new PortableJsonError('portable_json_limit');
    } else if (character === '}' || character === ']') {
      const current = stack.pop();
      if (current?.object !== (character === '}'))
        throw new PortableJsonError('portable_json_invalid');
    } else if (character === ',') {
      const current = stack.at(-1);
      if (current?.object === true) current.keyExpected = true;
    }
  }
  if (stack.length !== 0) throw new PortableJsonError('portable_json_invalid');
}

/** Shared browser/HTTP raw-file admission, never a tolerant JSON reader. */
export function parsePortableJson(text: string): unknown {
  if (
    new TextEncoder().encode(text).byteLength >
    WORKFLOW_PORTABILITY_LIMITS.bytes
  )
    throw new PortableJsonError('portable_json_limit');
  try {
    inspectJsonText(text);
    const value: unknown = JSON.parse(text);
    return portableSnapshot(value);
  } catch (error) {
    if (error instanceof PortableJsonError) throw error;
    throw new PortableJsonError('portable_json_invalid');
  }
}

function portableSnapshot(value: unknown): unknown {
  const inspected = inspectWorkflowGraphAdmission(value, {
    graphBytes: WORKFLOW_PORTABILITY_LIMITS.bytes,
    inputDepth: WORKFLOW_PORTABILITY_LIMITS.inputDepth,
    jsonValueDepth: 64,
    structuredDepth: 32,
  });
  if (!inspected.ok)
    throw new PortableJsonError(
      inspected.code === 'graph_limit' || inspected.code === 'json_value_depth'
        ? 'portable_json_limit'
        : 'portable_json_invalid',
    );
  return inspected.snapshot;
}

function sortedJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${sortedJson(record[key])}`)
    .join(',')}}`;
}

export function canonicalWorkflowPortableJson(value: unknown): string {
  return sortedJson(portableSnapshot(value));
}

async function digest(domain: string, value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(
    `${domain}\u0000${canonicalWorkflowPortableJson(value)}`,
  );
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function portableGraphDigest(
  graph: WorkflowGraph,
): Promise<string> {
  return digest(
    'pertexo.workflow.portable.source.v1',
    workflowGraphSchema.parse(graph),
  );
}

const identifier = z.string().min(1).max(1_048_576);
const boundedKey = z.string().min(1).max(128);
export const portableConnectionSlotSchema = z
  .object({
    nodeId: identifier,
    slot: boundedKey,
    providerKey: boundedKey,
    authType: boundedKey,
  })
  .strict();
export const portableConnectionBindingSchema = z
  .object({
    nodeId: identifier,
    slot: boundedKey,
    connectionId: z.uuid(),
  })
  .strict();
export const portableIssueSchema = z
  .object({
    code: boundedKey,
    path: z.string().max(2_048),
    message: z.string().max(512),
  })
  .strict();

const manifestObject = z
  .object({
    format: z.literal('pertexo.workflow'),
    formatVersion: z.literal(1),
    graph: workflowGraphSchema,
    requirements: z
      .object({
        definitions: z
          .array(
            z
              .object({
                key: boundedKey,
                version: z.number().int().positive(),
                configVersion: z.number().int().positive(),
              })
              .strict(),
          )
          .max(WORKFLOW_PORTABILITY_LIMITS.requirements),
      })
      .strict(),
    connectionSlots: z
      .array(portableConnectionSlotSchema)
      .max(WORKFLOW_PORTABILITY_LIMITS.connectionSlots),
  })
  .strict();

export const workflowPortableManifestStructuralSchema = manifestObject.extend({
  graph: workflowGraphStructuralSchema,
});
export const workflowPortableManifestSchema = z
  .unknown()
  .transform((input) => portableSnapshot(input))
  .pipe(manifestObject);

export type WorkflowPortableManifest = z.infer<
  typeof workflowPortableManifestSchema
>;
export type PortableConnectionSlot = z.infer<
  typeof portableConnectionSlotSchema
>;
export type PortableConnectionBinding = z.infer<
  typeof portableConnectionBindingSchema
>;
export type PortableIssue = z.infer<typeof portableIssueSchema>;

export async function portableManifestDigest(
  manifest: WorkflowPortableManifest,
): Promise<string> {
  return digest(
    'pertexo.workflow.portable.manifest.v1',
    workflowPortableManifestSchema.parse(manifest),
  );
}
