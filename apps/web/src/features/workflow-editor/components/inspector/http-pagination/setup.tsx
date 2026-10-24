import { nestedConfigForm } from '../../../model/inspector/nested-config-form';
import { useMemo } from 'react';
import { useScratchForm } from '../use-draft-field';
import { isRecord } from '@pertexo/workflow-model';
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Disclosure } from '@/components/ui/disclosure';
import { ChoiceSelect } from '../fields/choice-select';
import { SchemaField } from '../fields/schema-field';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import {
  withConfigValue,
  type NodeConfig,
} from '../../../model/inspector/draft';
import { paginationFields } from '../../../model/inspector/http-pagination/fields';
import {
  paginationDescription,
  paginationForMode,
  paginationModes,
  paginationValue,
} from '../../../model/inspector/http-pagination/draft';

export function HttpPaginationSetup({
  schema,
  config,
  form,
}: Readonly<{ schema: unknown; config: NodeConfig; form: NodeFormApi }>) {
  const { form: paginationForm, hasScratch } = useScratchForm(form);
  const nested = useMemo(
    () => nestedConfigForm(paginationForm, 'pagination'),
    [paginationForm],
  );
  const sourceForm = useMemo(
    () => nestedConfigForm(nested, 'source'),
    [nested],
  );
  const value = paginationValue(config);
  const mode = readMode(value, config);
  const label =
    paginationModes.find((choice) => choice.value === mode)?.label ??
    'Check setup';
  const id = fieldControlId(form.nodeId, 'pagination-mode');
  const modeHelpId = `${id}-help`;
  const paginationSelectionBlocked =
    !form.editable ||
    hasScratch ||
    (config.method !== 'GET' && value === undefined);
  return (
    <Disclosure
      summary={`Pagination · ${label}`}
      tone="strong"
      className="border-t border-border pt-3"
      contentClassName="mt-0 flex flex-col gap-4 pt-3"
    >
      <Field>
        <FieldLabel htmlFor={id}>Pagination mode</FieldLabel>
        <ChoiceSelect
          value={mode}
          choices={paginationModes}

          disabled={paginationSelectionBlocked}
          onChange={(next) => {
            if (next === null) return;
            form.commit(
              (node) => ({
                config: withConfigValue(
                  node.config,
                  'pagination',
                  paginationForMode(next, paginationValue(node.config)),
                ),
              }),
              `${form.nodeId}:pagination:mode`,
            );
          }}
          control={{ id: id, describedBy: modeHelpId }}
        />
        <FieldDescription id={modeHelpId}>
          {value === undefined
            ? 'Off fetches one response. Pagination combines JSON items from a GET request.'
            : paginationDescription(value)}{' '}
          {hasScratch
            ? 'Finish incomplete fields to change mode or source.'
            : null}
        </FieldDescription>
      </Field>
      {config.method !== 'GET' ? (
        <p className="text-sm text-muted-foreground">
          Pagination supports GET requests only. Choose GET or turn pagination
          off.
        </p>
      ) : null}
      {config.returnErrorResponses === true ? (
        <p className="text-sm text-muted-foreground">
          Turn off Return error responses before using pagination.
        </p>
      ) : null}
      {value === undefined ? null : (
        <PaginationFields
          schema={schema}
          value={value}
          form={nested}
          sourceForm={sourceForm}
          hasScratch={hasScratch}
          modeHelpId={modeHelpId}
        />
      )}
    </Disclosure>
  );
}
function PaginationFields({
  schema,
  value,
  form,
  sourceForm,
  hasScratch,
  modeHelpId,
}: Readonly<{
  schema: unknown;
  value: NodeConfig;
  form: NodeFormApi;
  sourceForm: NodeFormApi;
  hasScratch: boolean;
  modeHelpId: string;
}>) {
  const source = isRecord(value.source) ? (value.source as NodeConfig) : {};
  const fields = paginationFields(schema, value.mode, source.kind);
  return (
    <>
      {value.mode === 'next_link' ? (
        <Field>
          <FieldLabel
            htmlFor={fieldControlId(form.nodeId, 'pagination-source')}
          >
            Next link in
          </FieldLabel>
          <ChoiceSelect
            value={typeof source.kind === 'string' ? source.kind : null}
            choices={[
              { value: 'body', label: 'JSON response' },
              { value: 'link_header', label: 'Link header' },
            ]}
            disabled={!form.editable || hasScratch}

            onChange={(kind) => {
              if (kind === null) return;
              form.commit(
                (node) => ({
                  config: withConfigValue(
                    node.config,
                    'source',
                    kind === 'body' ? { kind, path: '$.next' } : { kind },
                  ),
                }),
                `${form.nodeId}:pagination:source`,
              );
            }}
            control={{
              id: fieldControlId(form.nodeId, 'pagination-source'),
              describedBy: modeHelpId,
            }}
          />
        </Field>
      ) : null}
      {fields.source.map((field) => (
        <SchemaField
          key={field.key}
          field={{ ...field, label: 'Next link path' }}
          config={source}
          form={sourceForm}
        />
      ))}
      {fields.common.map((field) => (
        <SchemaField key={field.key} field={field} config={value} form={form} />
      ))}
      <Field>
        <FieldLabel htmlFor={fieldControlId(form.nodeId, 'pagination-output')}>
          Results
        </FieldLabel>
        <ChoiceSelect
          value={value.outputMode === 'pages' ? 'pages' : 'inline'}
          disabled={!form.editable || hasScratch}
          choices={[
            { value: 'inline', label: 'Inline items' },
            { value: 'pages', label: 'Save items as pages' },
          ]}
          onChange={(mode) => {
            if (mode === null) return;
            form.commit(
              {
                config: withConfigValue(
                  value,
                  'outputMode',
                  mode === 'pages' ? 'pages' : undefined,
                ),
              },
              `${form.nodeId}:pagination:outputMode`,
            );
          }}
          control={{ id: fieldControlId(form.nodeId, 'pagination-output') }}
        />
        <FieldDescription>
          {value.outputMode === 'pages'
            ? 'Up to 10 MB / 100,000 items in 64 KB JSON-array files (at most 1,000 records each, 256 files). Map pages to For Each; Read file each page as inline data. pageCount counts stored files; fetchedPageCount counts API requests.'
            : 'Results are in items. The combined output must fit 1 MB.'}{' '}
          Each provider page must fit the inline limit. A retry starts again
          from the first page.
        </FieldDescription>
      </Field>
    </>
  );
}

function readMode(
  value: ReturnType<typeof paginationValue>,
  config: NodeConfig,
): string {
  if (typeof value?.mode === 'string') return value.mode;
  return config.pagination === undefined ? 'off' : 'custom';
}
