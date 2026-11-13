import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resolvePlatformNodeDefinition } from '@pertexo/node-catalog';
import { isRecord } from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';
import { browserDefinitions } from '../../../support/fixtures/node-catalog';
import { NewStep } from './schema-setup.fixture';
import { choose, optionsOf, saved } from './schema-setup-actions';

// Switching a step's operation must leave a setup the server accepts: the
// values both operations have stay, and the ones only the old operation
// had go. Checked with the step's own config schema (the one runs use),
// for every pair of operations, so no switch can save a setup a run
// would refuse.
const STEPS = [
  { key: 'core.text', label: 'Operation' },
  { key: 'core.date', label: 'Date operation' },
  { key: 'core.number', label: 'Operation' },
  { key: 'core.crypto', label: 'Operation' },
  { key: 'core.xml', label: 'Operation' },
  { key: 'core.html', label: 'Operation' },
] as const;

const catalog = browserDefinitions();

/** Each operation's own setting names, as the catalog schema lists them. */
function settingsByOperation(key: string): Map<string, Set<string>> {
  const definition = catalog.find((item) => item.definition.key === key);
  const schema: unknown = definition?.configSchema;
  const variants =
    isRecord(schema) && Array.isArray(schema.oneOf) ? schema.oneOf : [];
  return new Map(
    variants.flatMap((variant: unknown) => {
      if (!isRecord(variant) || !isRecord(variant.properties)) return [];
      const operation = variant.properties.operation;
      if (!isRecord(operation) || typeof operation.const !== 'string')
        return [];
      return [
        [operation.const, new Set(Object.keys(variant.properties))] as const,
      ];
    }),
  );
}

function acceptedByRuns(key: string, config: unknown) {
  const definition = catalog.find((item) => item.definition.key === key);
  return resolvePlatformNodeDefinition(
    definition?.definition,
  ).configSchema.safeParse(config).success;
}

function operationOf(config: unknown): string {
  if (!isRecord(config) || typeof config.operation !== 'string')
    throw new Error('Saved setup has no operation');
  return config.operation;
}

describe('switching a step’s operation', () => {
  it.each(STEPS)(
    'saves a setup runs accept for every switch on $key',
    async ({ key, label }) => {
      const settings = settingsByOperation(key);
      expect(settings.size).toBeGreaterThan(1);
      render(<NewStep stepKey={key} />);
      expect(acceptedByRuns(key, saved())).toBe(true);
      const names = await optionsOf(label);
      expect(names).toHaveLength(settings.size);
      for (const from of names)
        for (const to of names) {
          if (from === to) continue;
          await choose(label, from);
          const before = saved();
          await choose(label, to);
          const after = saved();
          const switched = `${key}: ${from} → ${to}`;
          expect(acceptedByRuns(key, after), switched).toBe(true);
          const own = settings.get(operationOf(after)) ?? new Set();
          const shared = settings.get(operationOf(before)) ?? new Set();
          for (const [name, value] of Object.entries(after as object)) {
            // Nothing the new operation doesn't have survives the switch.
            expect(own.has(name), `${switched} keeps ${name}`).toBe(true);
            // What both operations have keeps the value it had.
            if (name !== 'operation' && shared.has(name))
              expect(value, `${switched} ${name}`).toEqual(
                (before as Record<string, unknown>)[name],
              );
          }
        }
    },
  );

  it('keeps a typed selector and limit when HTML switches to an attribute', async () => {
    const user = userEvent.setup();
    render(<NewStep stepKey="core.html" />);
    const selector = screen.getByRole('textbox', { name: /selector/iu });
    await user.clear(selector);
    await user.type(selector, 'h1.title');
    const limit = screen.getByRole('textbox', { name: /limit|most/iu });
    await user.clear(limit);
    await user.type(limit, '7');
    await choose('Operation', 'Extract attribute');
    expect(saved()).toEqual({
      operation: 'attribute',
      selector: 'h1.title',
      attribute: 'href',
      limit: 7,
    });
    expect(acceptedByRuns('core.html', saved())).toBe(true);
    await choose('Operation', 'Extract text');
    expect(saved()).toEqual({
      operation: 'text',
      selector: 'h1.title',
      limit: 7,
    });
  });

  it('keeps a chosen locale and digits when Number switches to Currency and back', async () => {
    const user = userEvent.setup();
    render(<NewStep stepKey="core.number" />);
    const digits = screen.getByRole('textbox', {
      name: 'Maximum fraction digits',
    });
    await user.clear(digits);
    await user.type(digits, '4');
    await choose('Operation', 'Currency');
    await user.clear(screen.getByRole('textbox', { name: 'Currency' }));
    await user.type(screen.getByRole('textbox', { name: 'Currency' }), 'EUR');
    expect(saved()).toMatchObject({
      operation: 'currency',
      maximumFractionDigits: 4,
      currency: 'EUR',
    });
    await choose('Operation', 'Percent');
    expect(saved()).toEqual({
      operation: 'percent',
      locale: 'en-US',
      grouping: true,
      minimumFractionDigits: 0,
      maximumFractionDigits: 4,
    });
    expect(acceptedByRuns('core.number', saved())).toBe(true);
  });
});
