import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AccessibleWorkspace,
  WorkflowImportPreviewResponse,
} from '@pertexo/contracts';
import type {
  PortableConnectionBinding,
  WorkflowPortableManifest,
} from '@pertexo/workflow-model';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { describeCommandError } from '@/lib/api/error-copy';
import type { ApiClient } from '@/lib/api/client';
import { workflowNameError } from '../../model/rename';
import { readPortableWorkflowFile } from '../../model/portability';
import { previewWorkflowImport } from '../../data/portability/api';
import { usePortabilityLifetime } from './use-lifetime';
import { useWorkflowImportCommand } from '../../data/portability/mutations';
import {
  configureTemplate,
  setupValueError,
  templateOrigin,
  type CuratedTemplate,
} from '../../model/templates/curated-setup';

/** Owns source edits, preview validity and the lifetime of a retained import. */
export function useImportDraft(
  apiClient: ApiClient,
  userId: string,
  workspace: AccessibleWorkspace,
) {
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
  const readyPreview =
    preview?.compatible === true &&
    !preview.truncated &&
    complete &&
    !previewing
      ? preview
      : undefined;
  function submitImport() {
    if (lifetime.denied || command.state.kind === 'sending') return;
    if (command.state.kind === 'uncertain') command.retry();
    else if (
      configuredManifest !== undefined &&
      readyPreview !== undefined &&
      validation.submit({ name: workflowNameError(name) })
    ) {
      command.start({
        manifest: configuredManifest,
        ...(template === undefined
          ? {}
          : { templateOrigin: templateOrigin(template) }),
        bindings,
        name,
        expectedCompatibilityFingerprint: readyPreview.compatibilityFingerprint,
      });
      setPreview(undefined);
    }
  }
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
      await lifetime.verify(request.signal, true);
      if (!request.current()) return;
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
      await lifetime.verify(request.signal, true);
      if (!request.current()) return;
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
  function chooseTemplate(next: CuratedTemplate) {
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
  }
  function changeName(next: string) {
    invalidate();
    setName(next);
  }
  function changeSetup(index: number, next: string) {
    invalidate();
    setSetupValues((current) =>
      current.map((value, position) => (position === index ? next : value)),
    );
  }
  function changeBindings(next: PortableConnectionBinding[]) {
    invalidate();
    setBindings(next);
  }
  return {
    template,
    setupValues,
    name,
    bindings,
    manifest: configuredManifest ?? manifest,
    preview,
    error,
    reading,
    previewing,
    resetting,
    fileGeneration,
    validation,
    denied: lifetime.denied,
    locked,
    complete,
    commandState: command.state,
    canImport:
      readyPreview !== undefined && workflowNameError(name) === undefined,
    unresolved:
      !lifetime.denied &&
      (command.state.kind === 'sending' || command.state.kind === 'uncertain'),
    chooseTemplate,
    chooseFile,
    changeName,
    changeSetup,
    changeBindings,
    checkPreview,
    submitImport,
    startAnother,
  };
}
