import { createHash } from 'node:crypto';
import {
  NodeAttemptStateCorruptError,
  type NodeAttemptInputs,
} from './node-attempt-run-store-contract.js';
import {
  serializeStoredExecutionJsonValue,
  serializeWorkflowExecutionJsonValueV3,
} from '../stored-execution-value.js';

type Collection = Omit<
  NonNullable<NodeAttemptInputs['structuredCollection']>,
  'collection'
>;

function projectCollection(
  selection: Collection,
  value: unknown,
  serialize: (value: unknown) => string,
): NonNullable<NodeAttemptInputs['structuredCollection']> {
  if (value === null || Array.isArray(value) || typeof value !== 'object')
    throw new NodeAttemptStateCorruptError();
  const declaration = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(declaration).sort();
  const items = declaration.items;
  const count = declaration.iterationCount;
  const checksum = Array.isArray(items)
    ? createHash('sha256').update(serialize(items)).digest('hex')
    : undefined;
  if (
    keys.length !== 2 ||
    keys[0] !== 'items' ||
    keys[1] !== 'iterationCount' ||
    !Array.isArray(items) ||
    typeof count !== 'number' ||
    !Number.isSafeInteger(count) ||
    !Number.isSafeInteger(selection.ordinal) ||
    !Number.isSafeInteger(selection.collectionSize) ||
    count !== items.length ||
    selection.collectionSize !== items.length ||
    selection.ordinal < 0 ||
    selection.ordinal >= items.length ||
    selection.declaredCollectionChecksum !== checksum
  )
    throw new NodeAttemptStateCorruptError();
  return Object.freeze({ ...selection, collection: items });
}

/** Retained declaration semantics and existing retained byte limit are unchanged. */
export function projectRetainedNodeAttemptCollectionValue(
  selection: Collection,
  value: unknown,
) {
  return projectCollection(selection, value, serializeStoredExecutionJsonValue);
}

/** Native original output was hydrated by the current consumer's bounded codec. */
export function projectNativeNodeAttemptCollectionValue(
  selection: Collection,
  value: unknown,
) {
  serializeWorkflowExecutionJsonValueV3(value);
  return projectCollection(
    selection,
    value,
    serializeWorkflowExecutionJsonValueV3,
  );
}
