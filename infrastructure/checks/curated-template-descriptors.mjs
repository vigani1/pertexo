import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Build workflow-model first. These deliberately browser-safe facades own the assets
// and canonical format; this owner-installation tool never authors another graph.
import {
  CURATED_WORKFLOW_TEMPLATES,
  workflowTemplateOriginRequestSchema,
} from '../../packages/workflow-model/dist/curated-templates.js';
import {
  canonicalWorkflowPortableJson,
  portableManifestDigest,
  WORKFLOW_PORTABILITY_LIMITS,
  workflowPortableManifestSchema,
} from '../../packages/workflow-model/dist/portability-contract.js';

export const CURATED_TEMPLATE_SQL_BEGIN =
  '-- BEGIN GENERATED CURATED TEMPLATE DESCRIPTORS';
export const CURATED_TEMPLATE_SQL_END =
  '-- END GENERATED CURATED TEMPLATE DESCRIPTORS';

function encodeInventoryField(value) {
  if (typeof value !== 'string')
    throw new TypeError('Inventory field must be text');
  return `${String(Buffer.byteLength(value, 'utf8'))}:${value}`;
}

function encodeInventoryTarget(target) {
  if (Object.keys(target).sort().join(',') !== 'key,location,nodeId,valueKind')
    throw new TypeError(
      'Inventory target must contain exactly its four typed fields',
    );
  return encodeInventoryField(
    [target.nodeId, target.location, target.key, target.valueKind]
      .map(encodeInventoryField)
      .join(''),
  );
}

/** Length-prefix immutable fields for the independently implemented SQL readiness witness. */
export function computeCuratedTemplateInventoryDigest(inventory) {
  const rows = [...inventory].sort((left, right) =>
    left.templateId < right.templateId
      ? -1
      : left.templateId > right.templateId
        ? 1
        : left.templateVersion - right.templateVersion,
  );
  const encoded = rows
    .map((row) => {
      const targets =
        `${String(row.setupTargets.length)}:` +
        row.setupTargets.map(encodeInventoryTarget).join('');
      return encodeInventoryField(
        [
          row.templateId,
          String(row.templateVersion),
          String(row.schemaVersion),
          row.baseManifest,
          row.baseManifestDigest,
          targets,
          row.supportedProfile,
        ]
          .map(encodeInventoryField)
          .join(''),
      );
    })
    .join('');
  return createHash('sha256')
    .update('pertexo.workflow.curated-inventory.v1\0')
    .update(encoded, 'utf8')
    .digest('hex');
}

/** Immutable installed content; selectionEnabled is a mutable owner flag, not writer enablement. */
export async function buildCuratedTemplateDescriptorInventory() {
  const rows = [];
  const identities = new Set();
  for (const descriptor of CURATED_WORKFLOW_TEMPLATES) {
    workflowTemplateOriginRequestSchema.parse({
      schemaVersion: descriptor.schemaVersion,
      templateId: descriptor.templateId,
      templateVersion: descriptor.templateVersion,
      baseManifestDigest: descriptor.baseManifestDigest,
    });
    const identity = `${descriptor.templateId}:${String(descriptor.templateVersion)}`;
    if (identities.has(identity))
      throw new Error('Duplicate reviewed descriptor identity');
    identities.add(identity);
    const manifest = workflowPortableManifestSchema.parse(descriptor.manifest);
    const baseManifest = canonicalWorkflowPortableJson(manifest);
    if (
      Buffer.byteLength(baseManifest, 'utf8') >
        WORKFLOW_PORTABILITY_LIMITS.bytes ||
      (await portableManifestDigest(manifest)) !== descriptor.baseManifestDigest
    )
      throw new Error('Reviewed descriptor canonical manifest or digest drift');
    const setupTargets = JSON.parse(
      canonicalWorkflowPortableJson(descriptor.setupTargets),
    );
    if (
      setupTargets.length > 16 ||
      descriptor.supportedProfile !== 'validate_activation'
    )
      throw new Error('Reviewed descriptor targets or profile drift');
    const immutable = {
      templateId: descriptor.templateId,
      templateVersion: descriptor.templateVersion,
      schemaVersion: descriptor.schemaVersion,
      baseManifest,
      baseManifestDigest: descriptor.baseManifestDigest,
      setupTargets,
      supportedProfile: descriptor.supportedProfile,
    };
    const descriptorDigest = createHash('sha256')
      .update('pertexo.workflow.curated-descriptor.v1\0')
      .update(canonicalWorkflowPortableJson(immutable))
      .digest('hex');
    rows.push({ ...immutable, selectionEnabled: true, descriptorDigest });
  }
  return rows.sort((left, right) =>
    left.templateId < right.templateId
      ? -1
      : left.templateId > right.templateId
        ? 1
        : left.templateVersion - right.templateVersion,
  );
}

/** Dollar quoting preserves JSON escapes independently of standard_conforming_strings. */
export function curatedDescriptorSqlLiteral(value) {
  if (typeof value !== 'string')
    throw new TypeError('SQL literal requires text');
  let suffix = 0;
  let delimiter = '$curated$';
  while (value.includes(delimiter)) delimiter = `$curated_${String(++suffix)}$`;
  return `${delimiter}${value}${delimiter}`;
}

export async function generateCuratedTemplateDescriptorSql() {
  const inventory = await buildCuratedTemplateDescriptorInventory();
  const rows = inventory.map((row) =>
    [
      curatedDescriptorSqlLiteral(row.templateId),
      String(row.templateVersion),
      String(row.schemaVersion),
      `${curatedDescriptorSqlLiteral(row.baseManifest)}::text`,
      curatedDescriptorSqlLiteral(row.baseManifestDigest),
      `${curatedDescriptorSqlLiteral(canonicalWorkflowPortableJson(row.setupTargets))}::jsonb`,
      curatedDescriptorSqlLiteral(row.supportedProfile),
      'TRUE',
    ].join(', '),
  );
  return [
    CURATED_TEMPLATE_SQL_BEGIN,
    '-- Generated by infrastructure/checks/curated-template-descriptors.mjs; do not hand-edit.',
    '-- Selection is installed enabled; the independent template writer gate remains off.',
    'INSERT INTO app.curated_template_descriptors',
    '  (template_id, template_version, schema_version, base_manifest, base_manifest_digest, setup_targets, supported_profile, selection_enabled)',
    'VALUES',
    ...rows.map(
      (row, index) => `  (${row})${index === rows.length - 1 ? ';' : ','}`,
    ),
    CURATED_TEMPLATE_SQL_END,
    '',
  ].join('\n');
}

/** Exact byte witness inside the separately owned immutable migration. */
export async function validateCuratedTemplateDescriptorMigration(sql) {
  if (
    typeof sql !== 'string' ||
    sql.split(CURATED_TEMPLATE_SQL_BEGIN).length !== 2 ||
    sql.split(CURATED_TEMPLATE_SQL_END).length !== 2
  )
    throw new Error(
      'Migration must contain exactly one generated descriptor block',
    );
  const start = sql.indexOf(CURATED_TEMPLATE_SQL_BEGIN);
  const end = sql.indexOf(CURATED_TEMPLATE_SQL_END);
  const expected = await generateCuratedTemplateDescriptorSql();
  if (
    end < start ||
    sql.slice(start, end + CURATED_TEMPLATE_SQL_END.length + 1) !== expected
  )
    throw new Error(
      'Migration generated descriptor block differs from reviewed repository assets',
    );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stdout.write(await generateCuratedTemplateDescriptorSql());
  } else if (args.length === 1 && args[0] === '--inventory') {
    process.stdout.write(
      `${JSON.stringify(await buildCuratedTemplateDescriptorInventory(), null, 2)}\n`,
    );
  } else if (args.length === 1 && args[0] === '--inventory-digest') {
    process.stdout.write(
      `${computeCuratedTemplateInventoryDigest(await buildCuratedTemplateDescriptorInventory())}\n`,
    );
  } else if (args.length === 2 && args[0] === '--check') {
    await validateCuratedTemplateDescriptorMigration(
      await readFile(args[1], 'utf8'),
    );
    process.stdout.write(
      'Curated descriptor installation block matches reviewed assets.\n',
    );
  } else {
    throw new Error(
      'Usage: node infrastructure/checks/curated-template-descriptors.mjs [--inventory | --inventory-digest | --check migration.sql]',
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
