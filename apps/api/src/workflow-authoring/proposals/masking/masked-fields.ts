import {
  isMaskedAddress,
  type AssistantDisclosure,
} from '@pertexo/node-sdk/server';
import type { WorkflowNode } from '@pertexo/workflow-model';

/** The disclosure that applies to a step as saved, when its definition has one. */
export type DisclosureLookup = (
  node: WorkflowNode,
) => AssistantDisclosure | undefined;

// Stands for every undeclared field of a record, whose names may be private.
export const opaqueField = '@existing';
export const maskedSetting = { kind: 'existing_setting' } as const;
export const maskedMapping = {
  kind: 'literal',
  value: { kind: 'existing_mapping' },
} as const;
export const maskedConnection = '@existing_connection';

export type Fields = AssistantDisclosure['config'] | undefined;

/** The name a field takes in the projection, or nothing when it is visible. */
export function fieldMask(
  fields: Fields,
  key: string,
  value: unknown,
): string | undefined {
  if (fields?.visible.includes(key)) return undefined;
  if (fields?.masked.includes(key)) return key;
  if (fields?.addresses?.includes(key))
    return isMaskedAddress(value) ? key : undefined;
  if (fields?.unlisted === 'visible') return undefined;
  // Unknown keys can themselves contain private data from older or incomplete drafts.
  return fields?.unlisted === 'masked' ? key : opaqueField;
}
