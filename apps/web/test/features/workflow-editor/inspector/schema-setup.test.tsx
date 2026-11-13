import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SchemaFieldList } from '@/features/workflow-editor/components/inspector/fields/schema-list';
import { SchemaUnionSetup } from '@/features/workflow-editor/components/inspector/fields/union-setup';
import { startingConfig } from '@/features/workflow-editor/model/graph/starting-config';
import {
  coveredProperties,
  schemaFields,
  schemaPropertyCount,
  type NodeConfig,
} from '@/features/workflow-editor/model/inspector/draft';
import type { NodeFormApi } from '@/features/workflow-editor/model/inspector/node-form';
import { readSchemaUnion } from '@/features/workflow-editor/model/inspector/schema-union';
import { browserDefinitions } from '../../../support/fixtures/node-catalog';

const catalog = browserDefinitions();

function definitionOf(key: string) {
  const definition = catalog.find((item) => item.definition.key === key);
  if (definition === undefined) throw new Error(`No ${key} in the catalog`);
  return definition;
}

/** The setup a person sees for a new step, with what it stores. */
function NewStep({ stepKey }: Readonly<{ stepKey: string }>) {
  const definition = definitionOf(stepKey);
  const [config, setConfig] = useState<NodeConfig>(() =>
    startingConfig(definition, []),
  );
  const form: NodeFormApi = {
    nodeId: 'step',
    editable: true,
    reportScratch: vi.fn(),
    commit: (update) => {
      setConfig((current) => {
        const node = {
          id: 'step',
          definition: definition.definition,
          configVersion: 1,
          position: { x: 0, y: 0 },
          config: current,
          inputMappings: {},
          connectionRefs: {},
        };
        return (
          (typeof update === 'function' ? update(node) : update).config ??
          current
        );
      });
    },
  };
  const union = readSchemaUnion(definition.configSchema);
  const fields = schemaFields(definition.configSchema);
  return (
    <>
      {union === undefined ? (
        <SchemaFieldList
          fields={fields}
          config={config}
          form={form}
          jsonOnlySettings={
            schemaPropertyCount(definition.configSchema) >
            coveredProperties(fields)
          }
        />
      ) : (
        <SchemaUnionSetup union={union} config={config} form={form} />
      )}
      <output aria-label="Saved setup">{JSON.stringify(config)}</output>
    </>
  );
}

function saved(): unknown {
  return JSON.parse(
    screen.getByRole('status', { name: 'Saved setup' }).textContent,
  );
}

async function choose(name: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name }));
  await user.click(await screen.findByRole('option', { name: option }));
}

async function optionsOf(name: string): Promise<string[]> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name }));
  const options = (await screen.findAllByRole('option')).map(
    (option) => option.textContent,
  );
  await user.keyboard('{Escape}');
  return options;
}

describe('step setup drawn from the catalog schema', () => {
  it.each([
    {
      key: 'core.text',
      label: 'Operation',
      shown: 'Trim whitespace',
      options: [
        'Uppercase',
        'Lowercase',
        'Trim whitespace',
        'Replace text',
        'Split text',
        'Truncate text',
      ],
      help: /Matches are literal, never regex/u,
    },
    {
      key: 'core.date',
      label: 'Date operation',
      shown: 'ISO timestamp (UTC)',
      options: [
        'ISO timestamp (UTC)',
        'Epoch milliseconds',
        'Format timestamp',
        'Convert time zone',
        'Add or subtract duration',
      ],
      help: /a time with its offset like 2026-10-19T09:30:00\+02:00/u,
    },
    {
      key: 'core.number',
      label: 'Operation',
      shown: 'Decimal',
      options: ['Decimal', 'Percent', 'Currency'],
      help: /Percent formats 0.25 as 25%/u,
    },
    {
      key: 'core.crypto',
      label: 'Operation',
      shown: 'Hash text',
      options: ['Hash text', 'UUID', 'Random ID'],
      help: /UUID and random IDs change/u,
    },
    {
      key: 'core.xml',
      label: 'Operation',
      shown: 'XML to JSON',
      options: ['XML to JSON', 'JSON to XML'],
      help: /DTDs are not supported/u,
    },
    {
      key: 'core.html',
      label: 'Operation',
      shown: 'Extract text',
      options: ['Extract text', 'Extract attribute'],
      help: /Scripts never run/u,
    },
  ])(
    'shows $key with its words, choices and starting operation',
    async ({ key, label, shown, options, help }) => {
      render(<NewStep stepKey={key} />);
      const choice = screen.getByRole('combobox', { name: label });
      expect(choice).toHaveTextContent(shown);
      expect(screen.getByText(help)).toBeInTheDocument();
      expect(await optionsOf(label)).toEqual(options);
    },
  );

  it('shows each operation’s own settings with their starting values', async () => {
    render(<NewStep stepKey="core.number" />);
    expect(screen.getByRole('combobox', { name: 'Locale' })).toHaveTextContent(
      'en-US',
    );
    expect(screen.getByRole('switch', { name: 'Grouping' })).toBeChecked();
    expect(
      screen.getByRole('textbox', { name: 'Maximum fraction digits' }),
    ).toHaveValue('2');
    expect(screen.queryByRole('textbox', { name: 'Currency' })).toBeNull();
    await choose('Operation', 'Currency');
    expect(screen.getByRole('textbox', { name: 'Currency' })).toHaveValue(
      'USD',
    );
  });

  it('keeps the values two operations share and drops the rest', async () => {
    const user = userEvent.setup();
    render(<NewStep stepKey="core.date" />);
    await choose('Date operation', 'Format timestamp');
    expect(saved()).toEqual({
      operation: 'format',
      format: 'date_only',
      timeZone: 'UTC',
    });
    expect(screen.getByRole('combobox', { name: 'Format' })).toHaveTextContent(
      'Date only (YYYY-MM-DD)',
    );
    const zone = screen.getByRole('textbox', { name: 'Time zone' });
    await user.clear(zone);
    await user.type(zone, 'Europe/Paris');
    await choose('Date operation', 'Convert time zone');
    expect(saved()).toEqual({
      operation: 'convert_timezone',
      timeZone: 'Europe/Paris',
    });
    await choose('Date operation', 'Add or subtract duration');
    expect(saved()).toEqual({ operation: 'add_duration', unit: 'days' });
    expect(screen.queryByRole('textbox', { name: 'Time zone' })).toBeNull();
    expect(
      screen.getByRole('combobox', { name: 'Duration unit' }),
    ).toHaveTextContent('Days (24 hours)');
  });

  it('names stored choice IDs in words on a flat setup', async () => {
    render(<NewStep stepKey="core.filter" />);
    expect(
      screen.getByRole('combobox', { name: 'Comparison' }),
    ).toHaveTextContent('Equals');
    expect(await optionsOf('Comparison')).toContain('Field is missing');
    expect(
      screen.getByText(
        'Use $ for each whole item, or a path like $.paid for one field.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/only be edited as JSON/u)).toBeNull();
  });
});

describe('shapes the generic setup draws', () => {
  function Fields({
    schema,
    start = {},
  }: Readonly<{ schema: unknown; start?: NodeConfig }>) {
    const [config, setConfig] = useState<NodeConfig>(start);
    const fields = schemaFields(schema);
    const form: NodeFormApi = {
      nodeId: 'step',
      editable: true,
      reportScratch: vi.fn(),
      commit: (update) => {
        setConfig((current) => {
          const next =
            typeof update === 'function'
              ? update({
                  id: 'step',
                  definition: { key: 'partner.step', version: 1 },
                  configVersion: 1,
                  position: { x: 0, y: 0 },
                  config: current,
                  inputMappings: {},
                  connectionRefs: {},
                })
              : update;
          return next.config ?? current;
        });
      },
    };
    return (
      <>
        <SchemaFieldList
          fields={fields}
          config={config}
          form={form}
          jsonOnlySettings={
            schemaPropertyCount(schema) > coveredProperties(fields)
          }
        />
        <output aria-label="Saved setup">{JSON.stringify(config)}</output>
      </>
    );
  }

  it('draws one level of nested object as a named group', async () => {
    const user = userEvent.setup();
    render(
      <Fields
        schema={{
          type: 'object',
          properties: {
            retry: {
              type: 'object',
              title: 'Retry',
              properties: {
                attempts: { type: 'integer', title: 'Attempts', minimum: 1 },
                backoff: {
                  type: 'string',
                  enum: ['fixed', 'exponential'],
                  oneOf: [
                    { const: 'fixed', title: 'Fixed delay' },
                    { const: 'exponential', title: 'Doubling delay' },
                  ],
                },
              },
              required: ['attempts'],
            },
          },
        }}
      />,
    );
    const group = screen.getByRole('group', { name: 'Retry' });
    await user.type(
      within(group).getByRole('textbox', { name: 'Attempts' }),
      '3',
    );
    expect(saved()).toEqual({ retry: { attempts: 3 } });
    await choose('Backoff', 'Doubling delay');
    expect(saved()).toEqual({ retry: { attempts: 3, backoff: 'exponential' } });
    await user.clear(within(group).getByRole('textbox', { name: 'Attempts' }));
    await choose('Backoff', 'Not set');
    // Clearing the last value removes the group, not leaves `{}` behind.
    expect(saved()).toEqual({});
    expect(screen.queryByText(/only be edited as JSON/u)).toBeNull();
  });

  it('keeps shapes it can’t draw on Edit as JSON', () => {
    render(
      <Fields
        schema={{
          type: 'object',
          properties: {
            name: { type: 'string', title: 'Name' },
            deep: {
              type: 'object',
              properties: { inner: { type: 'object', properties: {} } },
            },
            tags: { type: 'array', items: { type: 'string' } },
          },
        }}
        start={{ tags: ['a'] }}
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
    expect(screen.queryByRole('group')).toBeNull();
    expect(
      screen.getByText('Some settings can only be edited as JSON.'),
    ).toBeInTheDocument();
    expect(saved()).toEqual({ tags: ['a'] });
  });
});
