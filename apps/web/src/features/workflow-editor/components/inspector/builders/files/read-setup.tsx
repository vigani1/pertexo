import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { useStepLastTest } from '../../../../hooks/use-last-test';
import { withConfigValue } from '../../../../model/inspector/draft';
import type { NodeConfig } from '../../../../model/inspector/draft';
import {
  sheetPreview,
  type SheetPreview,
} from '../../../../model/inspector/files/sheet-preview';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../../model/inspector/node-form';
import { ChoiceSelect } from '../../fields/choice-select';
import { SchemaField } from '../../fields/schema';
import { FormatTiles, type FileFormat } from './format-tiles';
import { SheetGrid } from './sheet-grid';
import { SheetTabs } from './sheet-tabs';

const READ_FORMATS = ['json', 'csv', 'xlsx'] as const;
const FORMAT_GUIDANCE: Readonly<Record<string, string>> = {
  json: 'JSON saved as UTF-8. For files over 1 MB, use pages; split files over 10 MB.',
  csv: 'CSV saved as UTF-8. For files over 1 MB, use pages; split files over 10 MB.',
  xlsx: 'An Excel workbook (.xlsx): one sheet, up to 1 MB inline or 10 MB as pages. Save .xls or macro-enabled .xlsm files as .xlsx first.',
};

export function ReadFileSetup({
  config,
  form,
}: Readonly<{ config: NodeConfig; form: NodeFormApi }>) {
  const format = typeof config.format === 'string' ? config.format : undefined;
  return (
    <>
      <Field>
        <FormatTiles
          id={fieldControlId(form.nodeId, 'format')}
          formats={READ_FORMATS}
          value={format}
          disabled={!form.editable}
          onChange={(next) => {
            form.commit(
              { config: startingConfig(next, config.outputMode === 'pages') },
              `${form.nodeId}:config:format:${next}`,
            );
          }}
        />
        <FieldDescription>
          {FORMAT_GUIDANCE[format ?? ''] ?? FORMAT_GUIDANCE.csv}
        </FieldDescription>
      </Field>
      <OutputMode config={config} form={form} />
      {format === 'xlsx' ? <ExcelSheet config={config} form={form} /> : null}
      {format === 'csv' ? (
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
      ) : null}
      {format === 'csv' || format === 'xlsx' ? (
        <SchemaField
          config={{ ...config, convertValues: config.convertValues ?? true }}
          form={form}
          field={{
            key: 'convertValues',
            label: 'Convert numbers and booleans',
            kind: 'boolean',
            required: true,
            description:
              format === 'xlsx'
                ? 'On by default: number and TRUE/FALSE cells keep their type, large integers stay as text, and dates become ISO text. Turn off to get every cell as text.'
                : 'On by default. Leading-zero identifiers, very large numbers and empty cells stay as text. Turn off to keep every cell as text.',
          }}
        />
      ) : null}
      <p className="text-xs text-muted-foreground">
        Choose the file on Inputs: map one from an earlier step or upload it
        there.
      </p>
    </>
  );
}

function startingConfig(format: FileFormat, pages: boolean): NodeConfig {
  const outputMode = pages ? { outputMode: 'pages' } : {};
  if (format === 'csv')
    return { format, delimiter: ',', convertValues: true, ...outputMode };
  if (format === 'xlsx')
    return { format, headerRow: 1, convertValues: true, ...outputMode };
  return { format, ...outputMode };
}

function OutputMode({
  config,
  form,
}: Readonly<{ config: NodeConfig; form: NodeFormApi }>) {
  const id = fieldControlId(form.nodeId, 'output-mode');
  return (
    <Field>
      <FieldLabel htmlFor={id}>Output</FieldLabel>
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
        control={{ id }}
      />
      <FieldDescription>
        {config.outputMode === 'pages'
          ? 'For files up to 10 MB or 100,000 records. The data arrives as pages of up to 1,000 records: loop over pages with For each, then read each page.'
          : `For files up to 1 MB, roughly 5,000 short rows. ${config.format === 'json' ? 'JSON gives its value.' : 'Each row becomes one item, keyed by the header.'}`}
      </FieldDescription>
    </Field>
  );
}

/** The sheet to read, drawn as a sheet: the last test's first rows above its tab. */
function ExcelSheet({
  config,
  form,
}: Readonly<{ config: NodeConfig; form: NodeFormApi }>) {
  const preview = sheetPreview(useStepLastTest(form.nodeId));
  const sheetId = fieldControlId(form.nodeId, 'sheet');
  const headerRow =
    typeof config.headerRow === 'number' ? config.headerRow : undefined;
  return (
    <>
      <Field>
        <FieldLabel htmlFor={sheetId}>Sheet</FieldLabel>
        <SheetGrid
          label="First rows from the last test"
          headerRow={headerRow ?? 1}
          headers={preview.kind === 'rows' ? preview.headers : undefined}
          rows={preview.kind === 'rows' ? preview.rows : []}
          caption={describePreview(preview)}
          stale={'stale' in preview && preview.stale}
          footer={
            <SheetTabs
              form={form}
              input={{
                id: sheetId,
                label: 'Sheet',
                value:
                  typeof config.sheet === 'string' ? config.sheet : undefined,
                placeholder: 'First visible sheet',
              }}
              suggestions={preview.kind === 'missing' ? preview.sheets : []}
              onCommit={(sheet) => {
                form.commit(
                  (node) => ({
                    config: withConfigValue(node.config, 'sheet', sheet),
                  }),
                  `${form.nodeId}:config:sheet`,
                );
              }}
            />
          }
        />
      </Field>
      <SchemaField
        config={{ ...config, headerRow: headerRow ?? 1 }}
        form={form}
        field={{
          key: 'headerRow',
          label: 'Header row',
          kind: 'integer',
          required: true,
          minimum: 1,
          maximum: 1_048_576,
          description:
            'The row with the column names. Rows above it, empty rows and trailing columns are skipped.',
        }}
      />
    </>
  );
}

function describePreview(preview: SheetPreview): string {
  switch (preview.kind) {
    case 'untested':
      return 'Test the step to see its first rows. An empty tab reads the first visible sheet.';
    case 'testing':
      return 'Testing the step…';
    case 'rows':
      return preview.total === 0
        ? 'The last test found the header row and no rows under it.'
        : `${String(preview.rows.length)} of ${preview.total.toLocaleString('en-US')} ${preview.total === 1 ? 'row' : 'rows'} from the last test.`;
    case 'pages':
      return `The last test stored ${preview.itemCount.toLocaleString('en-US')} rows as pages; choose Inline data to preview rows.`;
    case 'missing':
      return 'No sheet has that name. Choose one of the workbook’s sheets beside the tab.';
    case 'failed':
      return 'The last test couldn’t read this sheet; Test shows why.';
  }
}
