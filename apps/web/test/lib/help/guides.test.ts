import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUIDE_PATHS, HELP_LINKS, stepGuidePath } from '@/lib/help/guides';

const repository = resolve(import.meta.dirname, '../../../../..');

// Every key the app ships a guide link for; a step outside the list has none.
const GUIDED_KEYS = [
  'core.approval',
  'core.request_input',
  'core.form',
  'core.webhook',
  'core.respond_webhook',
  'core.foreach',
  'core.code',
  'core.create_file',
  'core.read_file',
  'core.run_values',
  'core.workflow_error',
  'core.wait',
  'core.set',
  'core.filter',
  'core.table_upsert',
  'http.request',
  'email.send_notification',
  'slack.send_message',
];

describe('help links', () => {
  it('point only at guides that exist in the repository', () => {
    for (const path of Object.values(GUIDE_PATHS))
      expect(existsSync(resolve(repository, path)), path).toBe(true);
    for (const key of GUIDED_KEYS) {
      const path = stepGuidePath(key);
      expect(path, key).toBeDefined();
      expect(existsSync(resolve(repository, path ?? '')), key).toBe(true);
    }
  });

  it('send the glossary link to the core terms', () => {
    expect(HELP_LINKS.glossary.endsWith('CONTEXT.md#core-terms')).toBe(true);
    expect(
      readFileSync(resolve(repository, GUIDE_PATHS.glossary), 'utf8'),
    ).toMatch(/^## Core terms$/mu);
  });

  it('has no guide for a step type without one', () => {
    expect(stepGuidePath('core.manual')).toBeUndefined();
    expect(stepGuidePath('core.schedule')).toBeUndefined();
  });
});
