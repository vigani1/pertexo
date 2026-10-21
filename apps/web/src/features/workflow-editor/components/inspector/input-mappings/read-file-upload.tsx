import { UploadFile, type FileUploadScope } from '@/features/artifacts/public';
import type { WorkflowNode } from '../../../model/graph/scopes';
import type { NodeFormApi } from '../../../model/inspector/node-form';

export function ReadFileUpload({
  scope,
  node,
  form,
  hasScratch,
}: Readonly<{
  scope: FileUploadScope;
  node: WorkflowNode;
  form: NodeFormApi;
  hasScratch: boolean;
}>) {
  return (
    <UploadFile
      scope={scope}
      targetKey={JSON.stringify(node.inputMappings)}
      disabled={!form.editable || hasScratch}
      label="Upload file to read"
      useLabel={
        node.inputMappings.file === undefined ? 'Use file' : 'Replace file'
      }
      description={
        node.config.outputMode === 'pages'
          ? 'Up to 10 MB, or the lower storage limit. Using this file replaces the file mapping. Split larger files.'
          : 'Inline reads support 1 MB. Choose Output pages on Setup for larger files up to 10 MB. Using this file replaces the file mapping.'
      }
      onUse={(reference) => {
        form.commit(
          (current) => ({
            inputMappings: {
              ...current.inputMappings,
              file: { kind: 'literal', value: reference },
            },
          }),
          `${node.id}:file:${reference.artifactId}`,
        );
        return undefined;
      }}
    />
  );
}
