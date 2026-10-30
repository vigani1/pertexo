import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { withConfigValue } from '../../../../model/inspector/draft';
import type { NodeConfig } from '../../../../model/inspector/draft';
import { fileColumnLimits } from '../../../../model/inspector/files/columns';
import { sheetCellText } from '../../../../model/inspector/files/sheet-preview';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../../model/inspector/node-form';
import { findStep } from '../../../../model/graph/scopes';
import { useEditorStore } from '../../../../model/state/context';
import { ChoiceSelect } from '../../fields/choice-select';
import { SchemaField } from '../../fields/schema';
import { ColumnOrder } from './column-order';
import { FormatTiles, type FileFormat } from './format-tiles';
import { SheetGrid } from './sheet-grid';
import { SheetTabs } from './sheet-tabs';
import { FILE_LIMIT_COPY } from '../../../../model/inspector/file-limit-copy';

const CREATE_FORMATS = ['json', 'csv', 'xlsx', 'text'] as const;

export function CreateFileSetup({
  schema,
  config,
  form,
}: Readonly<{ schema: unknown; config: NodeConfig; form: NodeFormApi }>) {
  const format = typeof config.format === 'string' ? config.format : undefined;
  const pages = config.inputMode === 'pages';
  return (
    <>
      <Field>
        <FormatTiles
          id={fieldControlId(form.nodeId, 'format')}
          formats={CREATE_FORMATS}
          value={format}
          disabled={!form.editable}
          onChange={(next) => {
            form.commit(
              { config: startingConfig(next, pages) },
              `${form.nodeId}:config:format:${next}`,
            );
          }}
        />
        <FieldDescription>
          {pages
            ? `Stream pages into a file up to ${FILE_LIMIT_COPY.file}, including headers and quoting.`
            : `Create a file up to ${FILE_LIMIT_COPY.inline} from inline data. Choose From pages for larger CSV, Excel or JSON files.`}
        </FieldDescription>
      </Field>
      {format === 'text' ? null : <DataSource config={config} form={form} />}
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
        <FileColumns schema={schema} config={config} form={form} />
      ) : null}
      {format === 'xlsx' ? <ExcelSheet config={config} form={form} /> : null}
      <p className="text-xs text-muted-foreground">
        {pages
          ? 'Map the pages list to Pages on Inputs. Files are read in order, one page at a time.'
          : 'Map Data on Inputs: rows with named fields for CSV or Excel, any value for JSON, or a string for plain text.'}{' '}
        The file can be read or sent by a later step.
      </p>
    </>
  );
}

function startingConfig(format: FileFormat, pages: boolean): NodeConfig {
  const inputMode = pages && format !== 'text' ? { inputMode: 'pages' } : {};
  if (format === 'csv')
    return { format, delimiter: ',', columns: [], ...inputMode };
  if (format === 'xlsx')
    return { format, sheetName: 'Sheet1', columns: [], ...inputMode };
  return { format, ...inputMode };
}

function DataSource({
  config,
  form,
}: Readonly<{ config: NodeConfig; form: NodeFormApi }>) {
  const id = fieldControlId(form.nodeId, 'input-mode');
  return (
    <Field>
      <FieldLabel htmlFor={id}>Data source</FieldLabel>
      <ChoiceSelect
        value={config.inputMode === 'pages' ? 'pages' : 'inline'}
        disabled={!form.editable}
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
        control={{ id }}
      />
      <FieldDescription>
        From pages reads the ordered page references on Inputs. CSV and Excel
        need explicit columns; the header is written once. Remove any
        incompatible Data or Pages mapping when changing source.
      </FieldDescription>
    </Field>
  );
}

function FileColumns({
  schema,
  config,
  form,
}: Readonly<{ schema: unknown; config: NodeConfig; form: NodeFormApi }>) {
  const limits = fileColumnLimits(schema);
  const { columns } = config;
  if (
    limits === undefined ||
    !Array.isArray(columns) ||
    columns.some((value) => typeof value !== 'string')
  )
    return (
      <p className="text-sm text-muted-foreground">
        Use Edit as JSON to choose the columns.
      </p>
    );
  return (
    <ColumnOrder
      form={form}
      columns={columns as string[]}
      limits={limits}
      hint={
        config.inputMode === 'pages'
          ? 'From pages needs the columns listed.'
          : 'Leave empty to use every field. Missing cells stay empty; formula-like text stays text.'
      }
      onChange={(next) => {
        form.commit(
          (node) => ({ config: { ...node.config, columns: [...next] } }),
          `${form.nodeId}:config:columns`,
        );
      }}
    />
  );
}

/**
 * The workbook as it will open: the bold header frozen above the first row
 * of the mapped data, and the sheet's name on its tab underneath.
 */
function ExcelSheet({
  config,
  form,
}: Readonly<{ config: NodeConfig; form: NodeFormApi }>) {
  const data = useEditorStore(
    (state) => findStep(state.graph, form.nodeId)?.inputMappings.data,
  );
  const first =
    data?.kind === 'literal' && Array.isArray(data.value)
      ? (data.value[0] as unknown)
      : undefined;
  const row =
    typeof first === 'object' && first !== null && !Array.isArray(first)
      ? (first as Readonly<Record<string, unknown>>)
      : undefined;
  const chosen = Array.isArray(config.columns)
    ? config.columns.filter((name): name is string => typeof name === 'string')
    : [];
  const headers = chosen.length > 0 ? chosen : Object.keys(row ?? {});
  const sheetId = fieldControlId(form.nodeId, 'sheet-name');
  return (
    <Field>
      <FieldLabel htmlFor={sheetId}>Sheet name</FieldLabel>
      <SheetGrid
        label="How the sheet starts"
        headerRow={1}
        headers={headers.length > 0 ? headers : undefined}
        rows={
          row === undefined
            ? []
            : [headers.map((name) => sheetCellText(row[name]))]
        }
        caption={
          row === undefined
            ? 'A bold header row, frozen above the data. Rows come from Data when the step runs.'
            : 'A bold header row, frozen above the data, then the first row of the mapped Data.'
        }
        footer={
          <SheetTabs
            form={form}
            input={{
              id: sheetId,
              label: 'Sheet name',
              value:
                typeof config.sheetName === 'string'
                  ? config.sheetName
                  : 'Sheet1',
            }}
            onCommit={(sheetName) => {
              form.commit(
                (node) => ({
                  config: withConfigValue(node.config, 'sheetName', sheetName),
                }),
                `${form.nodeId}:config:sheetName`,
              );
            }}
          />
        }
      />
    </Field>
  );
}
