import { describe, expect, it } from 'vitest';
import { startingConfig } from '@/features/workflow-editor/model/graph/starting-config';
import { browserDefinitions } from '../../../../support/fixtures/node-catalog';

const number = {
  locale: 'en-US',
  grouping: true,
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
};

// How every new step started before its starting values moved into the
// catalog schema (main at ce4c0f548). A new step must start the same way,
// so a saved draft looks exactly as it did.
const BEFORE: Readonly<Record<string, unknown>> = {
  'core.code': { code: 'return input;' },
  'core.respond_webhook': { bodyType: 'json' },
  'core.create_file': { format: 'csv', delimiter: ',', columns: [] },
  'core.read_file': { format: 'csv', delimiter: ',', convertValues: true },
  'core.batch': { size: 100 },
  'core.take': { count: 100 },
  'core.filter': { path: '$', operator: 'equals' },
  'core.sort': {
    path: '$',
    valueType: 'number',
    direction: 'ascending',
    missing: 'last',
  },
  'core.unique': { path: '$', missing: 'error' },
  'core.summarize': { valuePath: '$', missing: 'error' },
  'core.date': { operation: 'to_iso' },
  'core.parallel': {
    branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
    maxConcurrency: 2,
  },
  'core.switch': { cases: [{ id: 'case-01', equals: '' }] },
  'core.wait': { durationSeconds: 60 },
  'email.send_notification': { timeoutMillis: 10_000 },
  'slack.send_message': { timeoutMillis: 10_000 },
  'http.request': {
    method: 'GET',
    headers: {},
    timeoutMillis: 10_000,
    maxRedirects: 3,
    maxResponseBytes: 1_048_576,
    inlineResponseBytes: 65_536,
  },
  'core.hmac': { algorithm: 'sha256', encoding: 'hex' },
  'core.xml': { operation: 'parse' },
  'core.html': { operation: 'text', selector: 'a', limit: 100 },
  'core.crypto': { operation: 'hash', algorithm: 'sha256', encoding: 'hex' },
  'core.text': { operation: 'trim' },
  'core.number': { operation: 'decimal', ...number },
  'core.merge': { policy: { kind: 'all' } },
};

describe('a new step’s setup', () => {
  const catalog = browserDefinitions();
  const humanTasks = new Set([
    'core.form',
    'core.request_input',
    'core.approval',
  ]);

  it.each(
    catalog
      .filter(({ definition }) => !humanTasks.has(definition.key))
      .map((definition) => [definition.definition.key, definition] as const),
  )('starts %s the way it did before', (key, definition) => {
    // Validate used to start with an empty rule list, which its own schema
    // refuses (at least one rule); it now starts empty until "Add rule".
    const expected = key === 'core.validate' ? {} : (BEFORE[key] ?? {});
    expect(startingConfig(definition, [])).toEqual(expected);
  });

  it('gives each new step its own copy', () => {
    const date = catalog.find(
      ({ definition }) => definition.key === 'core.date',
    );
    if (date === undefined) throw new Error('No Date step in the catalog');
    const first = startingConfig(date, []);
    expect(startingConfig(date, [])).not.toBe(first);
  });
});
