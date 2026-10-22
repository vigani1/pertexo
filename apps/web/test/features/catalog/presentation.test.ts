import { describe, expect, it } from 'vitest';
import {
  describeConnectionRequirement,
  describeRetryBehaviour,
  describeStep,
  familyWord,
  prettifyDefinitionKey,
  stepGroupFor,
  stepGroups,
} from '@/features/catalog/presentation.public';

describe('step presentation registry', () => {
  it('names every catalog step in human words with its family', () => {
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
      const step = describeStep(key);
      expect(step.name).toBe(name);
      expect(step.family).toBe(family);
      expect(step.description.length).toBeGreaterThan(0);
      expect(step.description).not.toMatch(/\.$/u);
    }
    expect(describeStep('slack.send_message').sideEffect).toBe(
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
    expect(describeConnectionRequirement('slack_bot_token')).toBe(
      'Slack connection',
    );
    expect(describeConnectionRequirement('custom_token')).toBe(
      'Custom token connection',
    );
    expect(describeRetryBehaviour('unsafe')).toMatch(
      /never repeat a possibly dispatched effect/u,
    );
    expect(describeRetryBehaviour('idempotent-with-key')).toMatch(
      /idempotency key/u,
    );
  });
});
