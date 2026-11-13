import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { isRecord } from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';
import { browserDefinitions } from '../../../support/fixtures/node-catalog';
import { NewStep } from './schema-setup.fixture';
import { choose } from './schema-setup-actions';

// Every setting a catalog step describes must reach a screen reader with
// the setting: its words as the control's name, its help as the control's
// description, and, once a typed value is wrong, the error too. Checked on
// the real catalog, for every step the generic setup draws, so a step that
// gains a setting can't ship it unannounced.

// These steps have a setup of their own, not the generic one.
const OWN_SETUP = new Set([
  'core.approval',
  'core.form',
  'core.request_input',
  'core.code',
  'core.webhook',
  'core.wait',
  'core.respond_webhook',
  'core.read_file',
  'core.create_file',
  'core.schedule',
]);

type Setting = Readonly<{
  path: string;
  title?: string;
  description?: string;
  numeric: boolean;
}>;

const SCALAR = new Set(['string', 'integer', 'number', 'boolean']);

/** The scalar settings of one shape, one level of object deep. */
function scalarSettings(schema: unknown, parent = ''): Setting[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  return Object.entries(schema.properties).flatMap(
    ([key, property]): Setting[] => {
      if (!isRecord(property)) return [];
      const path = parent === '' ? key : `${parent}.${key}`;
      if (property.type === 'object' && parent === '')
        return scalarSettings(property, key);
      const scalar =
        typeof property.type === 'string'
          ? SCALAR.has(property.type)
          : Array.isArray(property.enum);
      if (!scalar || 'const' in property) return [];
      return [
        {
          path,
          numeric: property.type === 'integer' || property.type === 'number',
          ...(typeof property.description === 'string'
            ? { description: property.description }
            : {}),
          ...(typeof property.title === 'string'
            ? { title: property.title }
            : {}),
        },
      ];
    },
  );
}

function describedSettings(schema: unknown) {
  return scalarSettings(schema).filter(
    (setting): setting is Setting & { description: string } =>
      setting.description !== undefined,
  );
}

const CONTROLS = ['textbox', 'switch', 'combobox', 'spinbutton'] as const;

function controls(): HTMLElement[] {
  const setup = screen.getByTestId('setup');
  return CONTROLS.flatMap((role) => within(setup).queryAllByRole(role));
}

function expectAnnounced(
  step: string,
  setting: Setting & { description: string },
) {
  const matching = controls().filter((control) =>
    (control.getAttribute('aria-describedby') ?? '')
      .split(/\s+/u)
      .some(
        (id) =>
          document.getElementById(id)?.textContent.trim() ===
          setting.description.trim(),
      ),
  );
  expect(
    matching.length,
    `${step}: no control reads “${setting.description}”`,
  ).toBeGreaterThan(0);
  if (setting.title !== undefined) {
    const { title } = setting;
    const names = matching.map((control) =>
      screen.getAllByRole(control.getAttribute('role') ?? 'textbox', {
        name: (name) => name.startsWith(title),
      }),
    );
    expect(
      names.some((found) => found.some((item) => matching.includes(item))),
      `${step}: “${setting.description}” isn’t on a control named ${title}`,
    ).toBe(true);
  }
}

/** A wrong number reads its error with the field, after its help. */
async function expectErrorAnnounced(step: string, field: HTMLElement) {
  const user = userEvent.setup();
  const help = (field.getAttribute('aria-describedby') ?? '').split(/\s+/u);
  const before = (field as HTMLInputElement).value;
  await user.clear(field);
  await user.type(field, 'x');
  await user.tab();
  expect(field, step).toHaveAttribute('aria-invalid', 'true');
  const added = (field.getAttribute('aria-describedby') ?? '')
    .split(/\s+/u)
    .filter((id) => id !== '' && !help.includes(id));
  expect(
    added.map((id) => document.getElementById(id)?.textContent),
    `${step}: a wrong number’s error isn’t read with the field`,
  ).toEqual([expect.stringMatching(/\S/u)]);
  await user.clear(field);
  if (before !== '') await user.type(field, before);
  await user.tab();
}

const catalog = browserDefinitions();
const drawn = catalog
  .map((item) => item.definition.key)
  .filter((key) => !OWN_SETUP.has(key) && !key.startsWith('core.data_table'));

describe('catalog setup fields for assistive technology', () => {
  it('has drawn steps with described settings', () => {
    const described = drawn.filter((key) => {
      const schema = catalog.find(
        (item) => item.definition.key === key,
      )?.configSchema;
      const variants =
        isRecord(schema) && Array.isArray(schema.oneOf) ? schema.oneOf : [];
      return [schema, ...variants].some(
        (shape) => describedSettings(shape).length > 0,
      );
    });
    // The steps whose schema describes a drawn setting today; a new one
    // joins the check by itself.
    expect(described).toEqual(
      expect.arrayContaining([
        'core.batch',
        'core.crypto',
        'core.date',
        'core.filter',
        'core.sort',
        'core.summarize',
        'core.take',
        'core.unique',
        'http.request',
      ]),
    );
  });

  it.each(drawn)(
    'names %s’s settings and reads their help and errors with them',
    async (key) => {
      const schema: unknown = catalog.find(
        (item) => item.definition.key === key,
      )?.configSchema;
      render(
        <div data-testid="setup">
          <NewStep stepKey={key} />
        </div>,
      );
      const variants =
        isRecord(schema) && Array.isArray(schema.oneOf) ? schema.oneOf : [];
      const shapes: [string | undefined, unknown][] =
        variants.length === 0
          ? [[undefined, schema]]
          : variants.map((variant: unknown) => {
              const operation =
                isRecord(variant) && isRecord(variant.properties)
                  ? variant.properties.operation
                  : undefined;
              return [
                isRecord(operation) && typeof operation.title === 'string'
                  ? operation.title
                  : undefined,
                variant,
              ];
            });
      const picker =
        isRecord(schema) && typeof schema.title === 'string'
          ? schema.title
          : 'Operation';
      for (const [choice, shape] of shapes) {
        if (choice !== undefined) await choose(picker, choice);
        for (const setting of describedSettings(shape))
          expectAnnounced(`${key} ${choice ?? ''}`, setting);
        // Every control is named, and every typed number reads its error.
        for (const control of controls())
          expect(control, `${key} ${choice ?? ''}`).toHaveAccessibleName(/\S/u);
        for (const setting of scalarSettings(shape)) {
          if (!setting.numeric) continue;
          const field = document.querySelector<HTMLElement>(
            `[name="config.${setting.path}"]`,
          );
          expect(field, `${key} ${setting.path} isn’t drawn`).not.toBeNull();
          if (field !== null)
            await expectErrorAnnounced(`${key} ${setting.path}`, field);
        }
      }
    },
  );
});
