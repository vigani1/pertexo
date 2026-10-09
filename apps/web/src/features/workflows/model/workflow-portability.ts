import {
  parsePortableJson,
  canonicalWorkflowPortableJson,
  workflowPortableManifestSchema,
  WORKFLOW_PORTABILITY_LIMITS,
  type WorkflowPortableManifest,
} from '@pertexo/workflow-model';

export async function readPortableWorkflowFile(
  file: File,
): Promise<WorkflowPortableManifest> {
  if (file.size > WORKFLOW_PORTABILITY_LIMITS.bytes)
    throw new Error('Choose a workflow JSON file no larger than 2 MiB.');
  try {
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > WORKFLOW_PORTABILITY_LIMITS.bytes)
      throw new Error('Portable workflow byte limit exceeded');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return workflowPortableManifestSchema.parse(parsePortableJson(text));
  } catch {
    throw new Error(
      'This is not a valid portable workflow file, or it exceeds the supported limits.',
    );
  }
}

/** Fixed name, ephemeral object URL, no source names or resource identifiers. */
export function downloadPortableWorkflow(manifest: WorkflowPortableManifest) {
  const url = URL.createObjectURL(
    new Blob([canonicalWorkflowPortableJson(manifest)], {
      type: 'application/json',
    }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'pertexo-workflow.json';
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
