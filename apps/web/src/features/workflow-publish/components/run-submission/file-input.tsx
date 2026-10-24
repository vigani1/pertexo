import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { useState } from 'react';
import {
  canonicalizeJson,
  validateCallableValue,
} from '@pertexo/workflow-model';
import {
  UploadFile,
  type FileUploadScope,
  type FileReference,
} from '@/features/artifacts/public';
import { findWorkflowVersion } from '@/features/workflow-versions/public';
import type { JsonValue } from '@pertexo/workflow-model';
import { Checkbox } from '@/components/ui/checkbox';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/** The input remains JSON; a file occupies one explicitly named top-level property. */
export function FilePropertyUpload({
  scope,
  workflowId,
  versionId,
  input,
  disabled,
  onChange,
}: Readonly<{
  scope: FileUploadScope;
  workflowId: string;
  versionId: string;
  input: string;
  disabled: boolean;
  onChange: (value: string) => void;
}>) {
  const [property, setProperty] = useState('file');
  const [overwrite, setOverwrite] = useState(false);
  async function insert(reference: FileReference, signal: AbortSignal) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/u.test(property))
      return 'Use a property name of 1–64 letters, digits or underscores, starting with a letter or underscore.';
    let parsed;
    try {
      parsed = canonicalizeJson(JSON.parse(input) as unknown);
    } catch {
      return 'Correct the run input JSON before inserting a file.';
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return 'The run input must be a JSON object to insert a property. Its current value has been kept.';
    if (Object.hasOwn(parsed, property) && !overwrite)
      return `“${property}” already exists. Confirm replacement or choose another property.`;
    const next = {
      ...(parsed as Readonly<Record<string, JsonValue>>),
      [property]: reference,
    };
    const version = await findWorkflowVersion({
      apiClient: scope.apiClient,
      workspaceId: scope.workspaceId,
      workflowId,
      versionId,
      signal,
    });
    if (signal.aborted)
      return 'The input changed. Open the file control again.';
    if (version.graph.callable !== undefined) {
      const problem = validateCallableValue(version.graph.callable.input, next);
      if (problem !== undefined)
        return `This input does not match the published workflow contract at ${problem.path.length === 0 ? '$' : problem.path.join('.')}. Choose a compatible property or update the contract.`;
    }
    onChange(JSON.stringify(next, null, 2));
    return undefined;
  }
  return (
    <UploadFile
      targetKey={`${versionId}:${input}`}
      scope={scope}
      disabled={disabled}
      description="Insert a verified file reference in the run input. Map that property into an HTTP body to send its bytes."
      onUse={insert}
    >
      {({ disabled: inserting }) => (
        <>
          <LabelledField
            id="file-property"
            label="Input property"
            description="A top-level JSON property; map it as $.file by default."
          >
            {(control) => (
              <Input
                {...control}
                value={property}
                disabled={inserting}
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setProperty(event.currentTarget.value);
                  setOverwrite(false);
                }}
              />
            )}
          </LabelledField>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={overwrite}
              disabled={inserting}
              onCheckedChange={setOverwrite}
            />
            <span>Replace this property if it already exists</span>
          </label>
        </>
      )}
    </UploadFile>
  );
}

/** Upload admission belongs beside the run input; unavailable scopes expose no control. */
export function RunInputUpload({
  scope,
  versionId,
  input,
  disabled,
  onChange,
}: Readonly<{
  scope:
    | Readonly<{
        apiClient: ApiClient;
        userId: string;
        workspace: AccessibleWorkspace;
        workflow: WorkflowSummary;
      }>
    | undefined;
  versionId: string | undefined;
  input: string;
  disabled: boolean;
  onChange: (value: string) => void;
}>) {
  if (
    scope === undefined ||
    versionId === undefined ||
    !scope.workspace.capabilities.includes('artifact:upload')
  )
    return null;
  return (
    <FilePropertyUpload
      key={`${versionId}:${input}`}
      scope={{
        apiClient: scope.apiClient,
        userId: scope.userId,
        workspaceId: scope.workspace.id,
      }}
      workflowId={scope.workflow.id}
      versionId={versionId}
      input={input}
      disabled={disabled}
      onChange={onChange}
    />
  );
}
