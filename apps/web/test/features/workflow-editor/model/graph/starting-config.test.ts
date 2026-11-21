import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import { resolvePlatformNodeDefinition } from '@pertexo/node-catalog';
import { isRecord } from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';
import { startingConfig } from '@/features/workflow-editor/model/graph/starting-config';
import { browserDefinitions } from '../../../../support/fixtures/node-catalog';

const number = {
  locale: 'en-US',
  grouping: true,
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
};

const form = {
  title: 'Send a request',
  instructions: '',
  fields: [
    {
      id: 'field-1',
      name: 'message',
      label: 'Message',
      type: 'textarea',
      help: '',
      required: true,
    },
  ],
};

const approval = {
  title: 'Approval needed',
  instructions: '',
  expiresAfterSeconds: 604_800,
  audience: { roles: ['owner', 'admin'], memberIds: [] },
};

// Pin the steps already in the editor when the integration seam was fixed.
const BEFORE = {
  'core.approval': approval,
  'core.call': {},
  'core.concat': {},
  'core.condition': {},
  'core.foreach': {},
  'core.form': form,
  'core.manual': {},
  'core.request_input': { ...approval, ...form, title: 'Input needed' },
  'core.run_values': {},
  'core.schedule': {},
  'core.set': {},
  'core.table_delete': {},
  'core.table_find': {},
  'core.table_insert': {},
  'core.table_update': {},
  'core.table_upsert': {},
  'core.terminate': {},
  // An empty rule list is invalid, so Validate waits for "Add rule".
  'core.validate': {},
  'core.webhook': {},
  'core.workflow_error': {},
  'database.execute': { operation: 'query', sql: 'select 1 as value' },
  'database.poll': { schema: 'public', mode: 'new', intervalMinutes: 1 },
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
  'http.poll': { intervalMinutes: 1, itemsPath: '$', itemKeyPath: '$.id' },
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

const LEGACY_STEP_KEYS: ReadonlySet<string> = new Set(Object.keys(BEFORE));

describe('a new step’s setup', () => {
  const catalog = browserDefinitions();

  it.each(Object.entries(BEFORE))(
    'starts %s the way it did before',
    (key, expected) => {
      const definition = catalog.find((item) => item.definition.key === key);
      if (definition === undefined)
        throw new Error(`No ${key} step in the catalog`);
      expect(startingConfig(definition, [])).toEqual(expected);
    },
  );

  for (const item of catalog) {
    const { definition, configSchema } = item;
    if (LEGACY_STEP_KEYS.has(definition.key)) continue;

    it(`starts ${definition.key} with valid defaults from its catalog schema`, () => {
      const config = startingConfig(item, []);
      expect(config).toEqual(catalogDefaults(configSchema));
      // Drafts stay saveable while incomplete (ADR 053). A setting with no
      // default is the person's to enter; every value supplied must be valid.
      const parsed =
        resolvePlatformNodeDefinition(definition).configSchema.safeParse(
          config,
        );
      const supplied = (parsed.error?.issues ?? []).filter(
        (issue) => valueAt(config, issue.path) !== undefined,
      );
      expect(supplied).toEqual([]);
    });
  }

  it('gives each new step its own copy', () => {
    const date = catalog.find(
      ({ definition }) => definition.key === 'core.date',
    );
    if (date === undefined) throw new Error('No Date step in the catalog');
    const first = startingConfig(date, []);
    expect(startingConfig(date, [])).not.toBe(first);
  });
});

function catalogDefaults(schema: NodeDefinitionCatalogItem['configSchema']) {
  if (schema.default !== undefined) return schema.default;

  const properties = isRecord(schema.properties) ? schema.properties : {};
  const defaults: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(properties)) {
    if (isRecord(property) && 'default' in property) {
      defaults[key] = property.default;
    }
  }
  return defaults;
}

function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  return path.reduce<unknown>(
    (current, key) =>
      isRecord(current) && typeof key === 'string' ? current[key] : undefined,
    value,
  );
}
