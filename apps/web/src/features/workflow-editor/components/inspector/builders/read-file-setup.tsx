import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { withConfigValue } from '../../../model/inspector/draft';
import type { NodeConfig } from '../../../model/inspector/draft';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import { ChoiceSelect } from '../fields/choice-select';
import { SchemaField } from '../fields/schema-field';

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
          id={id}
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
        />
        <FieldDescription>
          Read strict UTF-8 CSV or JSON. Choose pages for files larger than 1
          MB; split files above 10 MB.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={fieldControlId(form.nodeId, 'output-mode')}>
          Output
        </FieldLabel>
        <ChoiceSelect
          id={fieldControlId(form.nodeId, 'output-mode')}
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
        />
        <FieldDescription>
          {config.outputMode === 'pages'
            ? 'Up to 10 MB / 100,000 records in 64 KB JSON-array files (at most 1,000 records each, 256 files). Output contains pages, itemCount and pageCount. For Each over pages, then Read file each page as inline data.'
            : 'Up to 1 MB; about 4,996 narrow rows fit the unchanged list limits. Wide rows fit fewer. CSV returns rows, JSON returns its value.'}
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
        {config.outputMode === 'pages'
          ? 'Map or upload a file on Inputs. The worker returns page references and counts; it does not load the full array into run data.'
          : 'Map a file reference on Inputs, or upload a file there. JSON returns its value; CSV returns rows keyed by their header names.'}
      </p>
    </>
  );
}
