import {
  formConfigSchema,
  inputRequestConfigSchema,
  isWorkflowTriggerDefinition,
  type ValueSource,
} from '@pertexo/workflow-model';
import type { GraphLevel, WorkflowNode } from '../../graph/scopes';
import { directPredecessorOptions } from './draft';
import { fileFieldsOf } from './schema';

type FormAnswerSource = Extract<
  ValueSource,
  { kind: 'run_input' } | { kind: 'node_output' }
>;

/** A form question that takes files; its answer is a list of `{ file, filename }`. */
export type FormFileField = Readonly<{ name: string; label: string }>;

/**
 * A form whose file answers a step can read: a Form trigger's arrive as the
 * run input, wherever the step sits; a Request input's are its own output,
 * so only the steps linked right after it read them.
 */
export type FormFiles = Readonly<{
  step: WorkflowNode;
  origin: 'run_input' | 'node_output';
  fields: readonly FormFileField[];
  /** Reads a path in the submitted answers: `$.values.<name>…`. */
  read: (path: string) => FormAnswerSource;
}>;

/** The steps whose setup is a form; both keep their questions in `fields`. */
const formSetups: Readonly<
  Record<string, typeof formConfigSchema | typeof inputRequestConfigSchema>
> = {
  'core.form': formConfigSchema,
  'core.request_input': inputRequestConfigSchema,
};

function fileFieldsOfForm(node: WorkflowNode): readonly FormFileField[] {
  const parsed = formSetups[node.definition.key]?.safeParse(node.config);
  if (parsed?.success !== true) return [];
  return parsed.data.fields.flatMap((field) =>
    field.type === 'file' ? [{ name: field.name, label: field.label }] : [],
  );
}

/** The form file answers a step can read, from the workflow and its level. */
export function formFilesFor(
  workflow: GraphLevel,
  level: GraphLevel,
  nodeId: string,
): readonly FormFiles[] {
  const forms = workflow.nodes.flatMap((step): FormFiles[] => {
    if (step.definition.key !== 'core.form') return [];
    const fields = fileFieldsOfForm(step);
    return fields.length === 0
      ? []
      : [
          {
            step,
            origin: 'run_input',
            fields,
            read: (path) => ({ kind: 'run_input', path }),
          },
        ];
  });
  const requests = directPredecessorOptions(level, nodeId).flatMap(
    ({ nodeId: sourceId }): FormFiles[] => {
      const step = level.nodes.find((node) => node.id === sourceId);
      if (step?.definition.key !== 'core.request_input') return [];
      const fields = fileFieldsOfForm(step);
      return fields.length === 0
        ? []
        : [
            {
              step,
              origin: 'node_output',
              fields,
              read: (path) => ({ kind: 'node_output', nodeId: step.id, path }),
            },
          ];
    },
  );
  return [...forms, ...requests];
}

/**
 * For a step that reads a file, the input that takes it and the form file
 * answers it can read; undefined for every other step.
 */
export function formFilesToRead(
  workflow: GraphLevel,
  level: GraphLevel,
  nodeId: string,
  inputSchema: unknown,
): Readonly<{ input: string; forms: readonly FormFiles[] }> | undefined {
  const input = fileFieldsOf(inputSchema).find(
    (field) => !field.sometimes,
  )?.key;
  return input === undefined
    ? undefined
    : { input, forms: formFilesFor(workflow, level, nodeId) };
}

/** Every file a field received, as a list Send email can attach whole. */
export function allFormFilesPath(field: FormFileField): string {
  return `$.values.${field.name}`;
}

/** The first file a field received, as the file reference Read file takes. */
export function firstFormFilePath(field: FormFileField): string {
  return `$.values.${field.name}[0].file`;
}

/**
 * Whether a run's input may carry a top-level `file`: not when every trigger
 * is a Form, whose files sit under their field instead.
 */
export function runInputMayCarryFile(workflow: GraphLevel): boolean {
  const triggers = workflow.nodes.filter((step) =>
    isWorkflowTriggerDefinition(step.definition),
  );
  return (
    triggers.length === 0 ||
    triggers.some((step) => step.definition.key !== 'core.form')
  );
}
