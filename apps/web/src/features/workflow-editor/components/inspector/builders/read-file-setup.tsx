import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
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
                    ? { format, delimiter: ',', convertValues: true }
                    : { format },
              },
              `${form.nodeId}:config:format:${format}`,
            );
          }}
        />
        <FieldDescription>
          Read a file up to 1 MB. About 4,996 narrow rows fit an end-to-end list
          workflow; wide rows fit fewer. Split larger files into smaller files
          for separate runs.
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
        Map a file reference on Inputs, or upload a file there. JSON returns its
        value; CSV returns rows keyed by their header names.
      </p>
    </>
  );
}
