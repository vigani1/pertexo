import { describe, expect, it } from 'vitest';
import {
  describeConnectionRequirement,
  describeRetryBehaviour,
  describeStep,
  familyWord,
  prettifyDefinitionKey,
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

  it('groups families under the add-step headings in order', () => {
    expect(stepGroups.map((group) => group.title)).toEqual([
      'Start with',
      'Do something',
      'Decide & flow',
      'Shape data',
      'Finish',
    ]);
  });

  it('describes connections and retry behaviour in plain words', () => {
    expect(describeConnectionRequirement('slack_bot_token')).toBe(
      'Slack connection',
    );
    expect(describeConnectionRequirement('custom_token')).toBe(
      'Custom token connection',
    );
    expect(describeRetryBehaviour('unsafe')).toMatch(/Won’t retry/u);
    expect(describeRetryBehaviour('idempotent-with-key')).toMatch(
      /idempotency key/u,
    );
  });
});
