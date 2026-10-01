import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type {
  PortableConnectionBinding,
  WorkflowImportPreviewResponse,
  WorkflowPortableManifest,
} from '@pertexo/contracts/schemas/workflow-portability';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { describeCommandError } from '@/lib/api/api-error-copy';
import type { ApiClient } from '@/lib/api/client';
import { workflowNameError } from '../../model/workflow-rename';
import { readPortableWorkflowFile } from '../../model/workflow-portability';
import { previewWorkflowImport } from '../../workflow-portability.api';
import { usePortabilityLifetime } from './use-portability-lifetime';
import { useWorkflowImportCommand } from '../../workflow-portability.mutations';
import { WorkflowImportLeaveGuard } from './workflow-import-leave-guard';
import {
  WorkflowImportConnections,
  WorkflowImportCompatibility,
} from './workflow-import-review';
import { PortableGraphReview } from './portable-graph-review';
import { CuratedTemplateChoice } from '../templates/curated-template-choice';
import {
  configureTemplate,
  setupValueError,
  templateOrigin,
  type CuratedTemplate,
} from '../../model/curated-template-setup';

export function WorkflowImportDialog({
  apiClient,
  userId,
  workspace,
  onClose,
  onCreated,
  open = true,
  onReopen,
  templatesEnabled = false,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  onClose: () => void;
  onCreated: (workflowId: string) => void;
  open?: boolean;
  onReopen?: () => void;
  templatesEnabled?: boolean;
}>) {
  const [template, setTemplate] = useState<CuratedTemplate>();
  const [setupValues, setSetupValues] = useState<string[]>([]);
  const [manifest, setManifest] = useState<WorkflowPortableManifest>();
  const [name, setName] = useState('');
  const [bindings, setBindings] = useState<PortableConnectionBinding[]>([]);
  const [preview, setPreview] = useState<WorkflowImportPreviewResponse>();
  const [error, setError] = useState<string>();
  const [reading, setReading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [fileGeneration, setFileGeneration] = useState(0);
  const resetBusy = useRef(false);
  const intent = useRef(0);
  const commandClear = useRef<() => void>(() => undefined);
  const validation = useFieldValidation<string>();
  const clear = useCallback(() => {
    intent.current += 1;
    setManifest(undefined);
    setTemplate(undefined);
    setSetupValues([]);
    setName('');
    setBindings([]);
    setPreview(undefined);
    setError(undefined);
    setReading(false);
    setPreviewing(false);
    setResetting(false);
    setFileGeneration((previous) => previous + 1);
    commandClear.current();
  }, []);
  const lifetime = usePortabilityLifetime(
    apiClient,
    userId,
    workspace.id,
    workspace.status === 'active' &&
      workspace.capabilities.includes('workflow:create'),
    clear,
  );
  const command = useWorkflowImportCommand(
    apiClient,
    userId,
    workspace.id,
    lifetime,
  );
  useEffect(() => {
    commandClear.current = command.clear;
  }, [command.clear]);
  const locked = lifetime.denied || command.state.kind !== 'editable';
  const configuredManifest =
    template === undefined
      ? manifest
      : configureTemplate(template, setupValues);
  const complete =
    manifest?.connectionSlots.every((slot) =>
      bindings.some(
        (binding) =>
          binding.nodeId === slot.nodeId && binding.slot === slot.slot,
      ),
    ) ?? false;
  async function startAnother() {
    if (
      command.state.kind !== 'confirmed' ||
      lifetime.denied ||
      resetBusy.current
    )
      return;
    resetBusy.current = true;
    setResetting(true);
    const request = lifetime.begin();
    try {
      if (!(await lifetime.verify(request.signal, true)) || !request.current())
        return;
      clear();
      validation.reset();
    } catch (failure) {
      if (request.current() && !lifetime.accessFailure(failure))
        setError(
          describeCommandError(
            failure,
            'checking access before starting another import',
          ),
        );
    } finally {
      request.done();
      resetBusy.current = false;
      if (request.current()) setResetting(false);
    }
  }
  function invalidate() {
    intent.current += 1;
    setPreview(undefined);
    setError(undefined);
  }
  async function chooseFile(file: File | undefined) {
    if (locked) return;
    invalidate();
    setTemplate(undefined);
    setSetupValues([]);
    setManifest(undefined);
    setBindings([]);
    setReading(false);
    validation.reset();
    if (file === undefined) return;
    const epoch = intent.current;
    const request = lifetime.begin();
    setReading(true);
    try {
      const parsed = await readPortableWorkflowFile(file);
      if (request.current() && epoch === intent.current) setManifest(parsed);
    } catch {
      if (request.current() && epoch === intent.current)
        setError(
          'Choose a valid portable workflow JSON file no larger than 2 MiB. Duplicate keys, excessive nesting and unsupported content are rejected.',
        );
    } finally {
      request.done();
      if (request.current() && epoch === intent.current) setReading(false);
    }
  }
  async function checkPreview() {
    const setupErrors = Object.fromEntries(
      template?.setupTargets.map((target, index) => [
        `setup-${String(index)}`,
        setupValueError(target, setupValues[index] ?? ''),
      ]) ?? [],
    );
    if (
      !complete ||
      locked ||
      previewing ||
      !validation.submit({ name: workflowNameError(name), ...setupErrors })
    )
      return;
    if (configuredManifest === undefined) return;
    const epoch = intent.current;
    const request = lifetime.begin();
    setPreview(undefined);
    setError(undefined);
    setPreviewing(true);
    try {
      if (!(await lifetime.verify(request.signal, true)) || !request.current())
        return;
      const result = await previewWorkflowImport(
        apiClient,
        workspace.id,
        {
          manifest: configuredManifest,
          bindings,
          ...(template === undefined
            ? {}
            : { templateOrigin: templateOrigin(template) }),
        },
        request.signal,
      );
      if (request.current() && epoch === intent.current) setPreview(result);
    } catch (failure) {
      if (
        request.current() &&
        epoch === intent.current &&
        !lifetime.accessFailure(failure)
      )
        setError(describeCommandError(failure, 'checking this import'));
    } finally {
      request.done();
      if (request.current()) setPreviewing(false);
    }
  }
  return (
    <>
      <WorkflowImportLeaveGuard
        workspaceId={workspace.id}
        unresolved={
          !lifetime.denied &&
          (command.state.kind === 'sending' ||
            command.state.kind === 'uncertain')
        }
        onReopen={() => onReopen?.()}
      />
      <Dialog
        open={open}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
          <DialogTitle>Import workflow</DialogTitle>
          <DialogDescription>
            {lifetime.denied
              ? 'Access changed. The file, preview and retained command have been cleared.'
              : `Create an independent, unpublished draft in “${workspace.name}”. Publishing and running are separate actions.`}
          </DialogDescription>
          {lifetime.denied ? null : (
            <div className="mt-5 flex flex-col gap-4">
              <Notice tone="warning">
                Workflow files are untrusted. Review all configuration and
                expressions before importing. Imported steps can cause real
                effects when you later publish, preview or run them. This check
                does not execute steps or promise that the workflow is safe.
              </Notice>
              {templatesEnabled ? (
                <CuratedTemplateChoice
                  apiClient={apiClient}
                  userId={userId}
                  disabled={locked}
                  onChoose={(next) => {
                    if (locked) return;
                    invalidate();
                    validation.reset();
                    setTemplate(next);
                    setReading(false);
                    setManifest(structuredClone(next.manifest));
                    setName(next.title);
                    setBindings([]);
                    // Destination literals must be supplied explicitly, never reused from demo data.
                    setSetupValues(next.setupTargets.map(() => ''));
                  }}
                />
              ) : null}
              <FieldGroup>
                <LabelledField
                  id="portable-workflow-file"
                  label="Workflow JSON file"
                  error={validation.error('file')}
                >
                  {(control) => (
                    <Input
                      key={fileGeneration}
                      {...control}
                      ref={validation.register('file')}
                      type="file"
                      accept=".json,application/json"
                      disabled={locked}
                      onChange={(event) =>
                        void chooseFile(event.target.files?.[0])
                      }
                    />
                  )}
                </LabelledField>
                <LabelledField
                  id="portable-workflow-name"
                  label="New workflow name"
                  error={validation.error('name')}
                >
                  {(control) => (
                    <Input
                      {...control}
                      ref={validation.register('name')}
                      value={name}
                      maxLength={128}
                      disabled={locked}
                      autoComplete="off"
                      onChange={(event) => {
                        invalidate();
                        setName(event.target.value);
                        validation.change(
                          'name',
                          workflowNameError(event.target.value),
                        );
                      }}
                    />
                  )}
                </LabelledField>
              </FieldGroup>
              {template === undefined ? null : (
                <FieldGroup>
                  {template.setupTargets.map((target, index) => (
                    <LabelledField
                      key={`${target.nodeId}:${target.key}`}
                      id={`template-setup-${String(index)}`}
                      label={
                        target.valueKind === 'https_endpoint'
                          ? 'HTTPS endpoint'
                          : 'Slack channel ID'
                      }
                      error={validation.error(`setup-${String(index)}`)}
                      description="Do not enter credentials or secrets."
                    >
                      {(control) => (
                        <Input
                          {...control}
                          ref={validation.register(`setup-${String(index)}`)}
                          value={setupValues[index] ?? ''}
                          maxLength={
                            target.valueKind === 'https_endpoint' ? 2048 : 128
                          }
                          disabled={locked}
                          autoComplete="off"
                          onChange={(event) => {
                            if (locked) return;
                            invalidate();
                            setSetupValues((current) =>
                              current.map((value, position) =>
                                position === index ? event.target.value : value,
                              ),
                            );
                            validation.change(
                              `setup-${String(index)}`,
                              setupValueError(target, event.target.value),
                            );
                          }}
                        />
                      )}
                    </LabelledField>
                  ))}
                  <p className="text-sm text-muted-foreground">
                    Historical origin records this initial template basis only.
                    Later edits do not remain synchronized with the example or
                    certify safety.
                  </p>
                </FieldGroup>
              )}
              {reading ? <p role="status">Reading workflow file…</p> : null}
              {manifest === undefined ? null : (
                <>
                  <PortableGraphReview
                    graph={(configuredManifest ?? manifest).graph}
                    label="Complete imported graph"
                  />
                  <WorkflowImportConnections
                    apiClient={apiClient}
                    userId={userId}
                    workspace={workspace}
                    slots={manifest.connectionSlots}
                    bindings={bindings}
                    disabled={locked}
                    onChange={(next) => {
                      invalidate();
                      setBindings(next);
                    }}
                  />
                </>
              )}
              {preview === undefined ? null : (
                <WorkflowImportCompatibility preview={preview} />
              )}
            </div>
          )}
          {(command.state.error ?? error) === undefined ? null : (
            <Notice
              tone={
                command.state.kind === 'uncertain' ? 'warning' : 'destructive'
              }
              className="mt-4"
            >
              {command.state.error ?? error}
            </Notice>
          )}
          {command.state.kind === 'confirmed' && !lifetime.denied ? (
            <Notice tone="success" className="mt-4">
              The independent workflow draft was created.
            </Notice>
          ) : null}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {command.state.kind === 'uncertain' ||
              command.state.kind === 'confirmed'
                ? 'Close'
                : 'Cancel'}
            </Button>
            {!locked ? (
              <ProgressButton
                variant="outline"
                pending={previewing}
                pendingLabel="Checking…"
                disabled={!complete || reading}
                onClick={() => void checkPreview()}
              >
                Preview import
              </ProgressButton>
            ) : null}
            {command.state.kind === 'confirmed' &&
            command.state.workflowId !== undefined &&
            !lifetime.denied ? (
              <>
                <ProgressButton
                  variant="outline"
                  pending={resetting}
                  pendingLabel="Checking access…"
                  onClick={() => void startAnother()}
                >
                  Start another import
                </ProgressButton>
                <Button
                  variant="primary"
                  onClick={() => {
                    if (command.state.workflowId !== undefined)
                      onCreated(command.state.workflowId);
                  }}
                >
                  Open imported workflow
                </Button>
              </>
            ) : (
              <ProgressButton
                variant="primary"
                pending={command.state.kind === 'sending'}
                pendingLabel="Importing…"
                disabled={
                  lifetime.denied ||
                  (command.state.kind !== 'uncertain' &&
                    (preview?.compatible !== true ||
                      preview.truncated ||
                      !complete ||
                      workflowNameError(name) !== undefined ||
                      previewing))
                }
                onClick={() => {
                  if (command.state.kind === 'uncertain') command.retry();
                  else if (
                    configuredManifest !== undefined &&
                    preview?.compatible === true &&
                    !preview.truncated &&
                    complete &&
                    validation.submit({ name: workflowNameError(name) })
                  ) {
                    command.start({
                      manifest: configuredManifest,
                      ...(template === undefined
                        ? {}
                        : { templateOrigin: templateOrigin(template) }),
                      bindings,
                      name,
                      expectedCompatibilityFingerprint:
                        preview.compatibilityFingerprint,
                    });
                    setPreview(undefined);
                  }
                }}
              >
                {command.state.kind === 'uncertain'
                  ? 'Retry exact import'
                  : 'Import unpublished draft'}
              </ProgressButton>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
