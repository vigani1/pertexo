import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildCuratedTemplateDescriptorInventory,
  computeCuratedTemplateInventoryDigest,
  curatedDescriptorSqlLiteral,
  generateCuratedTemplateDescriptorSql,
  validateCuratedTemplateDescriptorMigration,
  CURATED_TEMPLATE_SQL_BEGIN,
  CURATED_TEMPLATE_SQL_END,
} from './curated-template-descriptors.mjs';
import { CURATED_WORKFLOW_TEMPLATES } from '../../packages/workflow-model/dist/curated-templates.js';
import {
  canonicalWorkflowPortableJson,
  portableManifestDigest,
} from '../../packages/workflow-model/dist/portability-contract.js';

test('pins immutable inventory length-prefixed UTF8 digest independently of mutable selection', async () => {
  const inventory = await buildCuratedTemplateDescriptorInventory();
  const golden =
    'b2c003431f093031cdaebb97b78f8a9ddae81f8ce5fa14efd4035b639a3e9f75';
  assert.equal(computeCuratedTemplateInventoryDigest(inventory), golden);
  assert.equal(
    computeCuratedTemplateInventoryDigest([...inventory].reverse()),
    golden,
  );
  assert.equal(
    computeCuratedTemplateInventoryDigest(
      inventory.map((row) => ({
        ...row,
        selectionEnabled: false,
        descriptorDigest: 'ignored',
      })),
    ),
    golden,
  );
  for (const key of [
    'templateId',
    'baseManifest',
    'baseManifestDigest',
    'supportedProfile',
  ]) {
    const changed = structuredClone(inventory);
    changed[0][key] += 'changed';
    assert.notEqual(computeCuratedTemplateInventoryDigest(changed), golden);
  }
  for (const key of ['templateVersion', 'schemaVersion']) {
    const changed = structuredClone(inventory);
    changed[0][key] += 1;
    assert.notEqual(computeCuratedTemplateInventoryDigest(changed), golden);
  }
  for (const key of ['nodeId', 'location', 'key', 'valueKind']) {
    const changed = structuredClone(inventory);
    changed[0].setupTargets[0][key] += 'changed';
    assert.notEqual(computeCuratedTemplateInventoryDigest(changed), golden);
  }
  const reversedTargets = structuredClone(inventory);
  reversedTargets[0].setupTargets.reverse();
  assert.notEqual(
    computeCuratedTemplateInventoryDigest(reversedTargets),
    golden,
  );
  assert.notEqual(
    computeCuratedTemplateInventoryDigest(inventory.slice(1)),
    golden,
  );
  assert.notEqual(
    computeCuratedTemplateInventoryDigest([
      ...inventory,
      { ...inventory[0], templateVersion: 2 },
    ]),
    golden,
  );
  const extraTargetField = structuredClone(inventory);
  extraTargetField[0].setupTargets[0].extra = 'not ignored';
  assert.throws(() => computeCuratedTemplateInventoryDigest(extraTargetField));
});

test('inventory serialization prefixes UTF8 bytes, not JavaScript character lengths', () => {
  const expected = createHash('sha256')
    .update('pertexo.workflow.curated-inventory.v1\0')
    .update('24:1:a1:11:13:文1:d2:0:1:p', 'utf8')
    .digest('hex');
  assert.equal(
    computeCuratedTemplateInventoryDigest([
      {
        templateId: 'a',
        templateVersion: 1,
        schemaVersion: 1,
        baseManifest: '文',
        baseManifestDigest: 'd',
        setupTargets: [],
        supportedProfile: 'p',
      },
    ]),
    expected,
  );
});

test('derives all three canonical manifests, pinned digests and bounded typed targets from repository assets', async () => {
  const inventory = await buildCuratedTemplateDescriptorInventory();
  assert.deepEqual(
    inventory.map((row) => row.templateId),
    [
      'controlled-http-notification',
      'schedule-bounded-batch',
      'webhook-validation-routing',
    ],
  );
  assert.deepEqual(
    inventory.map((row) => row.descriptorDigest),
    [
      '3f204ce134522bfc81c496dcc4c4648224559766c69b0430fe705385c0666bc3',
      '24a39616fdc723ab89fd49a710b3eea463968eb0aa1265558e72795d8f7738c2',
      '536d85bb1fe63647a0dc18593c5ce4ad4a808cf82ca9a21a60ecdcde7076c410',
    ],
  );
  for (const row of inventory) {
    const descriptor = CURATED_WORKFLOW_TEMPLATES.find(
      (candidate) => candidate.templateId === row.templateId,
    );
    assert.ok(descriptor);
    assert.equal(
      row.baseManifest,
      canonicalWorkflowPortableJson(descriptor.manifest),
    );
    assert.equal(
      row.baseManifestDigest,
      await portableManifestDigest(descriptor.manifest),
    );
    assert.deepEqual(row.setupTargets, descriptor.setupTargets);
    assert.equal(row.selectionEnabled, true);
    assert.equal(row.supportedProfile, 'validate_activation');
    assert.equal(row.templateVersion, 1);
    assert.equal(row.schemaVersion, 1);
    assert.match(row.descriptorDigest, /^[a-f0-9]{64}$/u);
  }
  assert.deepEqual(await buildCuratedTemplateDescriptorInventory(), inventory);
});

test('generated installation SQL equals its checked artifact byte for byte', async () => {
  const sql = await generateCuratedTemplateDescriptorSql();
  assert.equal(
    sql,
    await readFile(
      new URL('./fixtures/curated-template-descriptors.sql', import.meta.url),
      'utf8',
    ),
  );
  await validateCuratedTemplateDescriptorMigration(
    `-- owner migration\n${sql}\n-- guard functions follow\n`,
  );
  assert.equal(sql.includes('UPDATE'), false);
  assert.equal(sql.includes('ON CONFLICT'), false);
  assert.equal(sql.includes('workflow_template_rollout'), false);
});

test('checks exact marked migration block and rejects omitted, duplicate, reordered or changed content', async () => {
  const sql = await generateCuratedTemplateDescriptorSql();
  const lines = sql.split('\n');
  const rowIndexes = lines.flatMap((line, index) =>
    line.startsWith('  ($curated$') ? [index] : [],
  );
  assert.equal(rowIndexes.length, 3);
  [lines[rowIndexes[0]], lines[rowIndexes[1]]] = [
    lines[rowIndexes[1]],
    lines[rowIndexes[0]],
  ];
  for (const invalid of [
    '',
    sql + sql,
    lines.join('\n'),
    sql.replace(CURATED_TEMPLATE_SQL_BEGIN, ''),
    sql.replace(CURATED_TEMPLATE_SQL_END, ''),
    sql.replace('TRUE', 'FALSE'),
    sql.replace('controlled-http-notification', 'unreviewed-template'),
    sql.replace(
      'https://example.test/curated-demo',
      'https://different.example.test',
    ),
    sql.replace('slack_channel_id', 'arbitrary_string'),
    sql.trimEnd(),
  ])
    await assert.rejects(validateCuratedTemplateDescriptorMigration(invalid));
});

test('SQL quoting preserves quotes, backslashes, Unicode and collision-bearing literal text', () => {
  for (const value of [
    "quoted'value",
    'JSON\\n\\u0027',
    'é',
    '$curated$',
    '$curated$$curated_1$',
  ]) {
    const quoted = curatedDescriptorSqlLiteral(value);
    const delimiter = /^\$[a-z0-9_]+\$/u.exec(quoted)?.[0];
    assert.ok(delimiter);
    assert.equal(quoted.slice(delimiter.length, -delimiter.length), value);
    assert.equal(value.includes(delimiter), false);
  }
  assert.throws(() => curatedDescriptorSqlLiteral(null));
});
