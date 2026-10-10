import { WORKFLOW_GRAPH_CONTRACT_LIMITS } from '@pertexo/contracts';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { WorkflowNode } from '../../../model/graph/scopes';
import { parseNumberField } from '../../../model/inspector/draft';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import { useInspectorDraftField } from '../use-draft-field';

type LoopStructure = NonNullable<WorkflowNode['structured']>;
type Limits = Pick<LoopStructure, 'maxIterations' | 'maxConcurrency'>;
type LimitText = Readonly<Record<keyof Limits, string>>;

const fields = [
  {
    key: 'maxIterations',
    label: 'Maximum items',
    maximum: WORKFLOW_GRAPH_CONTRACT_LIMITS.maxLoopIterations,
    description: 'The most items this loop may process.',
  },
  {
    key: 'maxConcurrency',
    label: 'Items at a time',
    maximum: WORKFLOW_GRAPH_CONTRACT_LIMITS.maxLoopConcurrency,
    description: 'Cannot exceed Maximum items.',
  },
] as const;

function inspectLimits(text: LimitText) {
  const errors: Partial<Record<keyof Limits, string>> = {};
  const values: Limits = {
    maxIterations: Number(text.maxIterations),
    maxConcurrency: Number(text.maxConcurrency),
  };
  for (const field of fields) {
    const result = parseNumberField(
      { ...field, kind: 'integer', required: true, minimum: 1 },
      text[field.key],
    );
    if (!result.ok) errors[field.key] = result.error;
  }
  if (
    Object.keys(errors).length === 0 &&
    values.maxConcurrency > values.maxIterations
  )
    errors.maxConcurrency = 'Items at a time cannot exceed Maximum items.';
  return { values, errors };
}

/** Both limits share scratch, so partial or incompatible values never save. */
export function LoopBoundsFields({
  structure,
  form,
}: Readonly<{ structure: LoopStructure; form: NodeFormApi }>) {
  const live = useInspectorDraftField<Limits, LimitText>({
    value: structure,
    equals: (left, right) =>
      left.maxIterations === right.maxIterations &&
      left.maxConcurrency === right.maxConcurrency,
    format: (limits) => ({
      maxIterations: String(limits.maxIterations),
      maxConcurrency: String(limits.maxConcurrency),
    }),
    parse: (text) => {
      const { values, errors } = inspectLimits(text);
      const error = errors.maxIterations ?? errors.maxConcurrency;
      return error === undefined
        ? { ok: true, value: values }
        : { ok: false, error };
    },
    commit: (limits) => {
      form.commit(
        (current) =>
          current.structured === undefined
            ? {}
            : { structured: { ...current.structured, ...limits } },
        `${form.nodeId}:structured:limits`,
      );
    },
    onScratchChange: (scratch) => {
      form.reportScratch('structured:limits', scratch);
    },
  });
  const errors =
    live.error === undefined ? {} : inspectLimits(live.text).errors;
  return (
    <FieldGroup className="gap-3">
      {fields.map((field) => {
        const id = fieldControlId(form.nodeId, `structured-${field.key}`);
        const error = errors[field.key];
        return (
          <Field key={field.key} data-invalid={error !== undefined}>
            <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
            <Input
              id={id}
              name={`structured.${field.key}`}
              inputMode="numeric"
              autoComplete="off"
              value={live.text[field.key]}
              disabled={!form.editable}
              aria-invalid={error !== undefined}
              aria-describedby={`${id}-description${error === undefined ? '' : ` ${id}-error`}`}
              onChange={(event) => {
                live.change({
                  ...live.text,
                  [field.key]: event.currentTarget.value,
                });
              }}
              onBlur={live.blur}
            />
            <FieldDescription id={`${id}-description`}>
              {field.description} From 1 to {field.maximum}.
            </FieldDescription>
            {error === undefined ? null : (
              <FieldError id={`${id}-error`}>{error}</FieldError>
            )}
          </Field>
        );
      })}
    </FieldGroup>
  );
}
