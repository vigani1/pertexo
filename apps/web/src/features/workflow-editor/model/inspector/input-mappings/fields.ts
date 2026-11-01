import { isRecord } from '@pertexo/workflow-model';
import { formFieldsOf, type FormFieldAnswer } from './form-files';
import { declaredFieldsOf, propertyPath, type DeclaredField } from './schema';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import type { WorkflowNode } from '../../graph/scopes';

/** One field Insert data lists: declared, seen in real output, or both. */
export type FieldNode = Readonly<{
  key: string;
  /** What a person calls it, when that isn't its key. */
  label?: string;
  path: string;
  type?: string;
  /** The value in real output, shortened to read in a list. */
  preview?: string;
  children: readonly FieldNode[];
  /** Children beyond what the list shows. */
  more: number;
}>;

const MAX_DEPTH = 6;
const MAX_CHILDREN = 50;
const PREVIEW_LENGTH = 60;

/** What a step says it returns, with a form's own questions under `values`. */
export function declaredStepFields(
  step: WorkflowNode,
  definition: NodeDefinitionCatalogItem | undefined,
): readonly DeclaredField[] {
  const declared = declaredFieldsOf(
    definition?.outputSchema,
    step,
    definition?.outputVariant,
  );
  const answers = formFieldsOf(step);
  if (answers === undefined) return declared;
  const values: DeclaredField = {
    key: 'values',
    type: 'object',
    children: answers.map(answerField),
  };
  return [...declared.filter((field) => field.key !== 'values'), values];
}

function answerField(answer: FormFieldAnswer): DeclaredField {
  return {
    key: answer.name,
    label: answer.label,
    ...(answer.type === undefined ? {} : { type: answer.type }),
  };
}

/**
 * Declared fields joined with real output. Real output wins on type, and
 * only it can show what's inside a value the step declares loosely, such as
 * an HTTP response's body.
 */
export function fieldTree(
  declared: readonly DeclaredField[],
  sample?: Readonly<{ value: unknown }>,
): Readonly<{ fields: readonly FieldNode[]; more: number }> {
  const { nodes, more } = childrenOf('$', declared, sample, 0);
  return { fields: nodes, more };
}

function childrenOf(
  path: string,
  declared: readonly DeclaredField[],
  sample: Readonly<{ value: unknown }> | undefined,
  depth: number,
): Readonly<{ nodes: readonly FieldNode[]; more: number }> {
  if (depth >= MAX_DEPTH) return { nodes: [], more: 0 };
  const value = sample?.value;
  if (Array.isArray(value)) return listChildren(path, declared, value, depth);
  const keys = new Set(declared.map((field) => field.key));
  if (isRecord(value)) for (const key of Object.keys(value)) keys.add(key);
  const shown = [...keys].slice(0, MAX_CHILDREN);
  return {
    nodes: shown.map((key) =>
      fieldNode(
        {
          key,
          path: `${path}${propertyPath(key).slice(1)}`,
          declared: declared.find((field) => field.key === key),
          sample:
            isRecord(value) && Object.hasOwn(value, key)
              ? { value: value[key] }
              : undefined,
        },
        depth,
      ),
    ),
    more: keys.size - shown.length,
  };
}

/** A list reads through its first item, the way n8n and Zapier show one. */
function listChildren(
  path: string,
  declared: readonly DeclaredField[],
  value: readonly unknown[],
  depth: number,
): Readonly<{ nodes: readonly FieldNode[]; more: number }> {
  if (value.length === 0) return { nodes: [], more: 0 };
  const first = { value: value[0] };
  const firstPath = `${path}[0]`;
  return isRecord(first.value)
    ? childrenOf(firstPath, declared, first, depth)
    : {
        nodes: [
          fieldNode(
            { key: '[0]', path: firstPath, declared: undefined, sample: first },
            depth,
          ),
        ],
        more: 0,
      };
}

function fieldNode(
  {
    key,
    path,
    declared,
    sample,
  }: Readonly<{
    key: string;
    path: string;
    declared: DeclaredField | undefined;
    sample: Readonly<{ value: unknown }> | undefined;
  }>,
  depth: number,
): FieldNode {
  const type = sample === undefined ? declared?.type : valueType(sample.value);
  const childPath =
    sample === undefined && declared?.list === true ? `${path}[0]` : path;
  const { nodes, more } = childrenOf(
    childPath,
    declared?.children ?? [],
    sample,
    depth + 1,
  );
  return {
    key,
    path,
    children: nodes,
    more,
    ...(declared?.label === undefined || declared.label === key
      ? {}
      : { label: declared.label }),
    ...(type === undefined ? {} : { type }),
    ...(sample === undefined ? {} : { preview: previewOf(sample.value) }),
  };
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function previewOf(value: unknown): string {
  if (Array.isArray(value))
    return value.length === 1 ? '1 item' : `${String(value.length)} items`;
  if (isRecord(value)) {
    const count = Object.keys(value).length;
    return count === 1 ? '1 field' : `${String(count)} fields`;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > PREVIEW_LENGTH
    ? `${text.slice(0, PREVIEW_LENGTH - 1)}…`
    : text;
}
