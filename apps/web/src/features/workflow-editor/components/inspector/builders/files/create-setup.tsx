import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
} from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { withConfigValue } from '../../../../model/inspector/draft';
import type { NodeConfig } from '../../../../model/inspector/draft';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../../model/inspector/node-form';
import {
  fileColumnLimits,
  parseFileColumns,
} from '../../../../model/inspector/transforms/file-columns';
import { useInspectorDraftField, useScratchForm } from '../../use-draft-field';
import { ChoiceSelect } from '../../fields/choice-select';
import { SchemaField } from '../../fields/schema';

export function CreateFileSetup({
  schema,
  config,
  form,
}: Readonly<{ schema: unknown; config: NodeConfig; form: NodeFormApi }>) {
  const { form: columnsForm, hasScratch } = useScratchForm(form);
  const id = fieldControlId(form.nodeId, 'format');
  return (
    <>
      <Field>
        <FieldLabel htmlFor={id}>File format</FieldLabel>
        <ChoiceSelect
          value={typeof config.format === 'string' ? config.format : null}
          disabled={!form.editable || hasScratch}
          choices={[
            { value: 'csv', label: 'CSV' },
            { value: 'json', label: 'JSON' },
            { value: 'text', label: 'Plain text' },
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
                        columns: [],
                        ...(config.inputMode === 'pages'
                          ? { inputMode: 'pages' }
                          : {}),
                      }
                    : {
                        format,
                        ...(format !== 'text' && config.inputMode === 'pages'
                          ? { inputMode: 'pages' }
                          : {}),
                      },
              },
              `${form.nodeId}:config:format:${format}`,
            );
          }}
          control={{ id: id }}
        />
        <FieldDescription>
          {formatGuidance({ hasScratch, inputMode: config.inputMode })}
        </FieldDescription>
      </Field>
      {config.format === 'text' ? null : (
        <Field>
          <FieldLabel htmlFor={fieldControlId(form.nodeId, 'input-mode')}>
            Data source
          </FieldLabel>
          <ChoiceSelect
            value={config.inputMode === 'pages' ? 'pages' : 'inline'}
            disabled={!form.editable || hasScratch}
            choices={[
              { value: 'inline', label: 'Inline data' },
              { value: 'pages', label: 'From pages' },
            ]}
            onChange={(mode) => {
              if (mode === null) return;
              form.commit(
                {
                  config: withConfigValue(
                    config,
                    'inputMode',
                    mode === 'pages' ? 'pages' : undefined,
                  ),
                },
                `${form.nodeId}:config:inputMode`,
              );
            }}
            control={{ id: fieldControlId(form.nodeId, 'input-mode') }}
          />
          <FieldDescription>
            From pages reads the ordered page references on Inputs. CSV needs
            explicit columns; it writes the header once. Remove any incompatible
            Data or Pages mapping when changing source.
          </FieldDescription>
        </Field>
      )}
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
          <FileColumns schema={schema} config={config} form={columnsForm} />
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {config.inputMode === 'pages'
          ? 'Map the pages list to Pages on Inputs. Files are read in order, one page at a time.'
          : 'Map Data on Inputs: rows with named fields for CSV, any value for JSON, or a string for plain text.'}{' '}
        The file can be read or sent by a later step.
      </p>
    </>
  );
}
function FileColumns({
  schema,
  config,
  form,
}: Readonly<{ schema: unknown; config: NodeConfig; form: NodeFormApi }>) {
  const limits = fileColumnLimits(schema);
  const columns = config.columns;
  if (
    limits === undefined ||
    !Array.isArray(columns) ||
    columns.some((value) => typeof value !== 'string' || /[\r\n]/u.test(value))
  )
    return (
      <p className="text-sm text-muted-foreground">
        Use Edit as JSON to choose CSV columns.
      </p>
    );
  return (
    <ColumnNames
      config={config}
      columns={columns as string[]}
      form={form}
      limits={limits}
    />
  );
}
function ColumnNames({
  config,
  columns,
  form,
  limits,
}: Readonly<{
  config: NodeConfig;
  columns: readonly string[];
  form: NodeFormApi;
  limits: NonNullable<ReturnType<typeof fileColumnLimits>>;
}>) {
  const id = fieldControlId(form.nodeId, 'columns');
  const live = useInspectorDraftField<readonly string[]>({
    value: columns,
    format: (value) => value.join('\n'),
    parse: (text) => parseFileColumns(text, limits),
    equals: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    commit: (value) => {
      form.commit(
        { config: { ...config, columns: value } },
        `${form.nodeId}:config:columns`,
      );
    },
    onScratchChange: (scratch) => {
      form.reportScratch('columns', scratch);
    },
  });
  return (
    <Field data-invalid={live.error !== undefined}>
      <FieldLabel htmlFor={id}>Columns, in output order</FieldLabel>
      <Textarea
        id={id}
        className="min-h-24 font-mono"
        autoComplete="off"
        spellCheck={false}
        value={live.text}
        disabled={!form.editable}
        aria-invalid={live.error !== undefined}
        aria-describedby={`${id}-hint${live.error === undefined ? '' : ` ${id}-error`}`}
        onChange={(event) => {
          live.change(event.currentTarget.value);
        }}
        onBlur={live.blur}
      />
      <FieldDescription id={`${id}-hint`}>
        One field name per line, up to {limits.count}. Leave empty to use all
        fields for inline data. From pages requires explicit columns. Missing
        cells are empty; spreadsheet formulas are protected.
      </FieldDescription>
      {live.error === undefined ? null : (
        <FieldError id={`${id}-error`}>{live.error}</FieldError>
      )}
    </Field>
  );
}

function formatGuidance(
  input: Readonly<{ hasScratch: boolean; inputMode: unknown }>,
) {
  if (input.hasScratch)
    return 'Finish or clear the column names before changing format.';
  if (input.inputMode === 'pages')
    return 'Stream pages into a file up to 10 MB, including CSV headers and quoting.';
  return 'Create a file up to 1 MB from inline data. Choose From pages for larger CSV or JSON files.';
}
