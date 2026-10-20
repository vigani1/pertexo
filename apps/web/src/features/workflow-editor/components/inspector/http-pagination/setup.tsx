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
  const mode =
    typeof value?.mode === 'string'
      ? value.mode
      : config.pagination === undefined
        ? 'off'
        : 'custom';
  const label =
    paginationModes.find((choice) => choice.value === mode)?.label ??
    'Check setup';
  const id = fieldControlId(form.nodeId, 'pagination-mode');
  const modeHelpId = `${id}-help`;
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
          id={id}
          value={mode}
          choices={paginationModes}
          describedBy={modeHelpId}
          disabled={
            !form.editable ||
            hasScratch ||
            (config.method !== 'GET' && value === undefined)
          }
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
            id={fieldControlId(form.nodeId, 'pagination-source')}
            value={typeof source.kind === 'string' ? source.kind : null}
            choices={[
              { value: 'body', label: 'JSON response' },
              { value: 'link_header', label: 'Link header' },
            ]}
            disabled={!form.editable || hasScratch}
            describedBy={modeHelpId}
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
      <p className="text-xs text-subtle-foreground">
        Results are in items. Each page must fit the inline limit; combined
        results must fit 1 MB. A retry starts again from the first page.
      </p>
    </>
  );
}
