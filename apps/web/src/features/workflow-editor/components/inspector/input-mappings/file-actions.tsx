import { UploadFile } from '@/features/artifacts/public';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import type { WorkflowNode } from '../../../model/graph/scopes';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { ReadFileUpload } from './read-file-upload';

/** Upload actions for steps that read a file directly from their inputs. */
export function InputFileActions({
  scope,
  node,
  form,
  editable,
  hasScratch,
}: Readonly<{
  scope: WorkspaceApiScope | undefined;
  node: WorkflowNode;
  form: NodeFormApi;
  editable: boolean;
  hasScratch: boolean;
}>) {
  const canUploadHttpBody =
    scope !== undefined &&
    node.definition.key === 'http.request' &&
    node.config.method !== 'GET' &&
    node.config.method !== 'HEAD';
  return (
    <>
      {scope !== undefined && node.definition.key === 'core.read_file' ? (
        <ReadFileUpload
          scope={scope}
          node={node}
          form={form}
          hasScratch={hasScratch}
        />
      ) : null}
      {canUploadHttpBody ? (
        <UploadFile
          targetKey={JSON.stringify(node.inputMappings)}
          scope={scope}
          disabled={!editable || hasScratch}
          label="Upload body file"
          useLabel={
            node.inputMappings.body === undefined
              ? 'Use file as body'
              : 'Replace body with file'
          }
          description="Send this file’s exact bytes as the HTTP request body. Using it replaces the current body mapping."
          onUse={(reference) => {
            form.commit(
              (current) => ({
                inputMappings: {
                  ...current.inputMappings,
                  body: { kind: 'literal', value: reference },
                },
              }),
              `${node.id}:file:${reference.artifactId}`,
            );
            return undefined;
          }}
        />
      ) : null}
    </>
  );
}
