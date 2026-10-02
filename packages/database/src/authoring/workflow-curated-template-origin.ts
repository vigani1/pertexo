import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  CURATED_WORKFLOW_TEMPLATES,
  verifyCuratedTemplateManifest,
} from '@pertexo/workflow-model/curated-templates';
import {
  canonicalWorkflowPortableJson,
  type PortableIssue,
} from '@pertexo/workflow-model/portability-contract';
import type { WorkflowPortabilityCatalog } from '@pertexo/workflow-model/portability';
import type { PreviewWorkflowImportInput } from './workflow-authoring-contracts.js';
import { WorkflowPortabilityUnavailableError } from './workflow-authoring-errors.js';

const storedDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    templateId: z.string(),
    templateVersion: z.number().int(),
    baseManifestDigest: z.string(),
    manifest: z.unknown(),
    setupTargets: z.unknown(),
    supportedProfile: z.literal('validate_activation'),
    selectionEnabled: z.boolean(),
  })
  .strict();
type StoredDescriptor = z.output<typeof storedDescriptorSchema>;

/** Called after authority/receipt/gate and before serving-catalog locks for new commands only. */
export async function readCuratedTemplateDescriptor(
  client: PoolClient,
  input: PreviewWorkflowImportInput,
  lock: boolean,
): Promise<StoredDescriptor | null> {
  if (input.templateOrigin === undefined) return null;
  const origin = input.templateOrigin;
  let result;
  try {
    result = await client.query<{ descriptor: unknown }>(
      lock
        ? 'select app.lock_curated_template_descriptor($1,$2) descriptor'
        : `select jsonb_build_object('schemaVersion',schema_version,'templateId',template_id,'templateVersion',template_version,
          'baseManifestDigest',base_manifest_digest,'manifest',base_manifest::jsonb,'setupTargets',setup_targets,
          'supportedProfile',supported_profile,'selectionEnabled',selection_enabled) descriptor
         from app.curated_template_descriptors where template_id=$1 and template_version=$2`,
      [origin.templateId, origin.templateVersion],
    );
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      ['42P01', '42703', '42883', '42501', '22P02'].includes(String(error.code))
    )
      throw new WorkflowPortabilityUnavailableError(
        'Template descriptor inventory is unavailable',
      );
    throw error;
  }
  const value = result.rows[0]?.descriptor;
  if (value === undefined || value === null) return null;
  const parsed = storedDescriptorSchema.safeParse(value);
  if (!parsed.success)
    throw new WorkflowPortabilityUnavailableError(
      'Template descriptor inventory is incompatible',
    );
  const reviewed = CURATED_WORKFLOW_TEMPLATES.find(
    (template) =>
      template.templateId === origin.templateId &&
      template.templateVersion === origin.templateVersion,
  );
  if (reviewed === undefined) return null;
  const { selectionEnabled: _selectionEnabled, ...installed } = parsed.data;
  const expected = {
    schemaVersion: reviewed.schemaVersion,
    templateId: reviewed.templateId,
    templateVersion: reviewed.templateVersion,
    baseManifestDigest: reviewed.baseManifestDigest,
    manifest: reviewed.manifest,
    setupTargets: reviewed.setupTargets,
    supportedProfile: reviewed.supportedProfile,
  };
  if (
    canonicalWorkflowPortableJson(installed) !==
    canonicalWorkflowPortableJson(expected)
  )
    throw new WorkflowPortabilityUnavailableError(
      'Template descriptor inventory is incompatible',
    );
  return parsed.data;
}

export function inspectCuratedTemplateOrigin(
  input: PreviewWorkflowImportInput,
  descriptor: StoredDescriptor | null,
  catalog: WorkflowPortabilityCatalog,
): readonly PortableIssue[] {
  if (input.templateOrigin === undefined) return [];
  if (!descriptor?.selectionEnabled)
    return [
      {
        code: 'template_origin_unavailable',
        path: '$.templateOrigin',
        message: 'This reviewed template is not available for new creation.',
      },
    ];
  const verified = verifyCuratedTemplateManifest(
    input.manifest,
    input.templateOrigin,
  );
  if (!verified.ok) return verified.issues;
  if (catalog.validateTemplateSetup === undefined)
    throw new WorkflowPortabilityUnavailableError(
      'Registered template setup validation is unavailable',
    );
  if (!catalog.validateTemplateSetup(input.manifest, input.templateOrigin))
    return [
      {
        code: 'template_setup_invalid',
        path: '$.manifest',
        message:
          'Template setup does not satisfy the registered serving policy.',
      },
    ];
  return [];
}
