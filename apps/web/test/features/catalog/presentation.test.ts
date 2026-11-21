import { browserConnectionDefinitions } from '../../support/fixtures/node-catalog';
import { describe, expect, it } from 'vitest';
import { browserDefinitions } from '../../support/fixtures/node-catalog';
import { GlobeIcon, HashIcon } from 'lucide-react';
import { stepIcons } from '@/features/catalog/model/steps/registry';
import {
  catalogStepDescriptions,
  describeConnectionRequirement,
  describeRetryBehaviour,
  describeStep,
  familyWord,
  prettifyDefinitionKey,
  stepGroupFor,
  stepGroups,
} from '@/features/catalog/public';

const definitions = browserDefinitions();
const describeServedStep = catalogStepDescriptions(definitions);

describe('step presentation registry', () => {
  it('keeps established step names and side-effect explanations', () => {
    const expected = {
      'core.webhook': ['Webhook', 'trigger'],
      'core.schedule': ['Schedule', 'trigger'],
      'core.manual': ['Manual start', 'trigger'],
      'core.set': ['Set fields', 'transform'],
      'core.validate': ['Validate', 'transform'],
      'core.condition': ['Condition', 'logic'],
      'core.switch': ['Switch', 'logic'],
      'core.parallel': ['Parallel', 'logic'],
      'core.merge': ['Merge', 'logic'],
      'core.foreach': ['For each', 'logic'],
      'core.wait': ['Wait', 'logic'],
      'core.terminate': ['Stop run', 'output'],
      'http.request': ['HTTP request', 'action'],
      'slack.send_message': ['Send Slack message', 'action'],
      'email.send_notification': ['Send email', 'action'],
    } as const;
    for (const [key, [name, family]] of Object.entries(expected)) {
      const step = describeServedStep(key);
      expect(step.name).toBe(name);
      expect(step.family).toBe(family);
      expect(step.description.length).toBeGreaterThan(0);
      expect(step.description).not.toMatch(/\.$/u);
    }
    expect(describeServedStep('slack.send_message').sideEffect).toBe(
      'This sends a real Slack message.',
    );
  });

  it('falls back to a prettified key and the catalog family for unknown steps', () => {
    expect(prettifyDefinitionKey('acme_crm.create_contact')).toBe(
      'Create contact',
    );
    expect(prettifyDefinitionKey('vendor')).toBe('Vendor');
    const unknown = describeStep('acme_crm.create_contact', 'action');
    expect(unknown).toMatchObject({ name: 'Create contact', family: 'action' });
    expect(describeStep('core.retired').family).toBe('unknown');
    expect(familyWord('unknown')).toBe('Step');
  });

  it('groups steps under the add-step headings in order', () => {
    expect(stepGroups.map((group) => group.title)).toEqual([
      'Start with',
      'Do something',
      'Decide & flow',
      'Work with lists',
      'Text, numbers and dates',
      'Files and formats',
      'IDs and signatures',
      'Fields and code',
      'Finish',
    ]);
  });

  it('places each step in the section that lists it, else its family’s catch-all', () => {
    expect(stepGroupFor('core.table_find', 'transform')?.title).toBe(
      'Do something',
    );
    expect(stepGroupFor('core.run_values', 'transform')?.title).toBe(
      'Do something',
    );
    expect(stepGroupFor('core.date', 'transform')?.title).toBe(
      'Text, numbers and dates',
    );
    // A data step nobody has placed yet still appears.
    expect(stepGroupFor('core.future_step', 'transform')?.title).toBe(
      'Fields and code',
    );
    expect(stepGroupFor('http.request', 'action')?.title).toBe('Do something');
  });

  it('describes connections and retry behaviour in plain words', () => {
    expect(
      describeConnectionRequirement(
        'slack_bot_token',
        browserConnectionDefinitions,
      ),
    ).toBe('Slack connection');
    expect(
      describeConnectionRequirement(
        'custom_token',
        browserConnectionDefinitions,
      ),
    ).toBe('Custom token connection');
    expect(describeRetryBehaviour('unsafe')).toMatch(
      /never repeat a possibly dispatched effect/u,
    );
    expect(describeRetryBehaviour('idempotent-with-key')).toMatch(
      /idempotency key/u,
    );
  });
});

it('uses the supplied catalog family even for a known step', () => {
  expect(describeStep('core.set', 'action')).toMatchObject({
    name: 'Set fields',
    family: 'action',
  });
});

it('presents every actual catalog definition using its owned display vocabulary', () => {
  for (const item of definitions) {
    expect(item.display, item.definition.key).toBeDefined();
    const shown = describeServedStep(item.definition, item.family);
    expect(shown).toMatchObject({ ...item.display, family: item.family });
    expect(shown.icon).toBeDefined();
    expect(shown.name.length).toBeGreaterThan(0);
    expect(shown.description.length).toBeGreaterThan(0);
  }
});

it('keeps the hand-written step icon list limited to core steps', () => {
  expect(
    Object.keys(stepIcons).filter((key) => !key.startsWith('core.')),
  ).toEqual([]);
});

it('uses the pinned catalog version and falls back for an unknown icon', () => {
  const item = definitions.find(
    ({ definition }) => definition.key === 'slack.send_message',
  );
  if (item?.presentation === undefined || item.display === undefined)
    throw new Error('Missing Slack presentation');
  const updated = {
    ...item,
    definition: { ...item.definition, version: item.definition.version + 1 },
    presentation: {
      ...item.presentation,
      icon: 'constructor',
      name: 'Post a message',
    },
  };
  const describe = catalogStepDescriptions([updated, item]);
  expect(describe(item.definition)).toMatchObject({
    name: 'Send Slack message',
    icon: HashIcon,
  });
  expect(describe(updated.definition)).toMatchObject({
    name: 'Post a message',
    icon: GlobeIcon,
  });
  expect(describe(item.definition.key).name).toBe('Post a message');
});
