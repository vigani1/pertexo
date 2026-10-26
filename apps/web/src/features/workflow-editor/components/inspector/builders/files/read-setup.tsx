import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { withConfigValue } from '../../../../model/inspector/draft';
import type { NodeConfig } from '../../../../model/inspector/draft';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../../model/inspector/node-form';
import { ChoiceSelect } from '../../fields/choice-select';
import { SchemaField } from '../../fields/schema';

export function ReadFileSetup({
  config,
  form,
}: Readonly<{ config: NodeConfig; form: NodeFormApi }>) {
  const id = fieldControlId(form.nodeId, 'format');
  return (
    <>
      <Field>
        <FieldLabel htmlFor={id}>File format</FieldLabel>
        <ChoiceSelect
          value={typeof config.format === 'string' ? config.format : null}
          disabled={!form.editable}
          choices={[
            { value: 'csv', label: 'CSV' },
            { value: 'json', label: 'JSON' },
          ]}
          onChange={(format) => {
            if (format === null) return;
            form.commit(
              {
                config:
                  format === 'csv'
                    ? {
                        format,
                        delimiter: ',',
                        convertValues: true,
                        ...(config.outputMode === 'pages'
                          ? { outputMode: 'pages' }
                          : {}),
                      }
                    : {
                        format,
                        ...(config.outputMode === 'pages'
                          ? { outputMode: 'pages' }
                          : {}),
                      },
              },
              `${form.nodeId}:config:format:${format}`,
            );
          }}
          control={{ id: id }}
        />
        <FieldDescription>
          CSV or JSON, saved as UTF-8. For files over 1 MB, use pages; split
          files over 10 MB.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={fieldControlId(form.nodeId, 'output-mode')}>
          Output
        </FieldLabel>
        <ChoiceSelect
          value={config.outputMode === 'pages' ? 'pages' : 'inline'}
          disabled={!form.editable}
          choices={[
            { value: 'inline', label: 'Inline data' },
            { value: 'pages', label: 'Output pages' },
          ]}
          onChange={(mode) => {
            if (mode === null) return;
            form.commit(
              {
                config: withConfigValue(
                  config,
                  'outputMode',
                  mode === 'pages' ? 'pages' : undefined,
                ),
              },
              `${form.nodeId}:config:outputMode`,
            );
          }}
          control={{ id: fieldControlId(form.nodeId, 'output-mode') }}
        />
        <FieldDescription>
          {config.outputMode === 'pages'
            ? 'For files up to 10 MB or 100,000 records. The data arrives as pages of up to 1,000 records: loop over pages with For each, then read each page.'
            : 'For files up to 1 MB, roughly 5,000 short rows. CSV gives one item per row, keyed by the header; JSON gives its value.'}
        </FieldDescription>
      </Field>
      {config.format === 'csv' ? (
        <>
          <SchemaField
            config={config}
            form={form}
            field={{
              key: 'delimiter',
              label: 'Delimiter',
              kind: 'string',
              required: true,
              options: [',', ';', '\t'],
              optionLabels: { ',': 'Comma', ';': 'Semicolon', '\t': 'Tab' },
            }}
          />
          <SchemaField
            config={{ ...config, convertValues: config.convertValues ?? true }}
            form={form}
            field={{
              key: 'convertValues',
              label: 'Convert numbers and booleans',
              kind: 'boolean',
              required: true,
              description:
                'On by default. Leading-zero identifiers, very large numbers and empty cells stay as text. Turn off to keep every cell as text.',
            }}
          />
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Choose the file on Inputs: map one from an earlier step or upload it
        there.
      </p>
    </>
  );
}
