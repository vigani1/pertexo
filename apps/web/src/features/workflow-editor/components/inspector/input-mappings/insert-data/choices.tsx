import {
  callbackMappingExpression,
  callbackWaitConfigSchema,
} from '@pertexo/workflow-model';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import { RepeatIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { describeStep, StepTile } from '@/features/catalog/presentation.public';
import { findDefinition, stepTitle } from '../../../../model/graph/adapter';
import type { WorkflowNode } from '../../../../model/graph/scopes';
import {
  firstFormFilePath,
  type FormFiles,
  type formFilesToRead,
} from '../../../../model/inspector/input-mappings/form-files';
import {
  outputFieldsOf,
  propertyPath,
  type OutputField,
} from '../../../../model/inspector/input-mappings/schema';
import type { InsertedSource } from '../../../../model/inspector/input-mappings/reference';

/** What a body step can read about the item it runs for (ADR 020). */
const loopFields: Readonly<
  Record<string, Readonly<{ label: string; type: string; name: string }>>
> = {
  item: { label: 'Whole item', type: 'any', name: 'item' },
  ordinal: { label: 'Position (0, 1, 2…)', type: 'integer', name: 'ordinal' },
};

export function FieldList({
  fields,
  wholeLabel = 'Whole output',
  onPick,
  children,
}: Readonly<{
  fields: readonly OutputField[];
  wholeLabel?: string;
  onPick: (path: string, fieldName: string) => void;
  /** More choices from the same source, such as a form's files. */
  children?: ReactNode;
}>) {
  return (
    <ul className="mt-1 ml-3 flex flex-col border-l border-surface-ink/8 pl-2">
      <li>
        <PickButton
          label={wholeLabel}
          type="object"
          onClick={() => {
            onPick('$', '');
          }}
        />
      </li>
      {fields.map((field) => (
        <li key={field.key}>
          <PickButton
            label={field.key}
            {...(field.type === undefined ? {} : { type: field.type })}
            onClick={() => {
              onPick(propertyPath(field.key), field.key);
            }}
          />
        </li>
      ))}
      {children}
    </ul>
  );
}

/** The first file each form question received, for a step that reads one. */
export function FirstFormFiles({
  toRead,
  from,
  onPick,
}: Readonly<{
  toRead: ReturnType<typeof formFilesToRead>;
  from: (form: FormFiles) => boolean;
  onPick: (source: InsertedSource, fieldName: string) => void;
}>) {
  if (toRead === undefined) return null;
  return toRead.forms.filter(from).flatMap((form) =>
    form.fields.map((field) => (
      <li key={`${form.step.id}:${field.name}`}>
        <PickButton
          label={`first file from ${field.label}`}
          type="file"
          onClick={() => {
            onPick(form.read(firstFormFilePath(field)), toRead.input);
          }}
        />
      </li>
    )),
  );
}

function PickButton({
  label,
  type,
  onClick,
}: Readonly<{ label: string; type?: string; onClick: () => void }>) {
  return (
    <button
      type="button"
      className="flex w-full items-center justify-between gap-3 rounded-sm px-1.5 py-1 text-left text-[0.8rem] text-muted-foreground outline-none hover:bg-surface-ink/5 hover:text-accent-foreground focus-ring"
      onClick={onClick}
    >
      <span className="truncate">{label}</span>
      {type === undefined ? null : (
        <span className="font-mono text-[0.66rem] text-subtle-foreground">
          {type}
        </span>
      )}
    </button>
  );
}

export function LoopInputChoices({
  loopPorts,
  onPick: pick,
}: Readonly<{
  loopPorts: readonly string[];
  onPick: (source: InsertedSource, fieldName: string) => void;
}>) {
  return loopPorts.length > 0 ? (
    <li>
      <p className="flex items-center gap-2 text-[0.8rem] font-semibold">
        <RepeatIcon aria-hidden="true" className="size-3.5 text-secondary" />
        This item
      </p>
      <ul className="mt-1 ml-3 flex flex-col border-l border-surface-ink/8 pl-2">
        {loopPorts.map((port) => {
          const field = loopFields[port] ?? {
            label: port,
            type: 'any',
            name: port,
          };
          return (
            <li key={port}>
              <PickButton
                label={field.label}
                type={field.type}
                onClick={() => {
                  pick(
                    { kind: 'structured_input', port, path: '$' },
                    field.name,
                  );
                }}
              />
            </li>
          );
        })}
      </ul>
    </li>
  ) : null;
}

export function CallbackInputChoices({
  target,
  onPick: pick,
}: Readonly<{
  target: WorkflowNode;
  onPick: (source: InsertedSource, fieldName: string) => void;
}>) {
  return (
    <li>
      <p className="text-[0.8rem] font-semibold">
        {stepTitle(target)} · callback
      </p>
      <ul className="mt-1 ml-3 flex flex-col border-l border-surface-ink/8 pl-2">
        {(callbackWaitConfigSchema.parse(target.config).authentication.mode ===
        'secret_url'
          ? (['url'] as const)
          : (['url', 'secret'] as const)
        ).map((field) => (
          <li key={field}>
            <PickButton
              label={field === 'url' ? 'Callback URL' : 'Authentication secret'}
              type="credential"
              onClick={() => {
                pick(
                  {
                    kind: 'expression',
                    expression: callbackMappingExpression(target.id, field),
                  },
                  field === 'url' ? 'callbackUrl' : 'callbackSecret',
                );
              }}
            />
          </li>
        ))}
      </ul>
    </li>
  );
}

export function NodeOutputChoices({
  source,
  definitions,
  onPick: pick,
  children,
}: Readonly<{
  source: WorkflowNode;
  definitions: readonly NodeDefinitionCatalogItem[];
  onPick: (source: InsertedSource, fieldName: string) => void;
  children?: ReactNode;
}>) {
  const definition = findDefinition(definitions, source);
  const step = describeStep(source.definition.key, definition?.family);
  return (
    <li>
      <p className="flex items-center gap-2 text-[0.8rem] font-semibold">
        <StepTile step={step} size="sm" />
        {stepTitle(source)}
      </p>
      <FieldList
        fields={outputFieldsOf(
          definition?.outputSchema,
          source,
          definition?.outputVariant,
        )}
        onPick={(path, name) => {
          pick({ kind: 'node_output', nodeId: source.id, path }, name);
        }}
      >
        {children}
      </FieldList>
    </li>
  );
}
