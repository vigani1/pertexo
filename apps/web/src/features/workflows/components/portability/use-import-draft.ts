import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';
import { useQuery } from '@tanstack/react-query';
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
import {
  connectionSlotKey,
  optionalConnectionSlots,
  readPortableWorkflowFile,
} from '../../model/portability';
import { authoringCatalogQueryOptions } from '@/features/catalog/queries.public';
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
  initialName = '',
) {
  const [template, setTemplate] = useState<CuratedTemplate>();
  const [setupValues, setSetupValues] = useState<string[]>([]);
  const [manifest, setManifest] = useState<WorkflowPortableManifest>();
  const [name, setName] = useState(initialName);
  const customName = useRef(initialName.trim() !== '');
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
    customName.current = false;
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
  const catalog = useQuery({
    ...authoringCatalogQueryOptions(apiClient, userId),
    enabled: manifest !== undefined,
  });
  const optionalSlots =
    manifest === undefined || catalog.data === undefined
      ? new Set<string>()
      : optionalConnectionSlots(manifest, catalog.data.definitions.items);
  const complete =
    manifest?.connectionSlots.every(
      (slot) =>
        optionalSlots.has(connectionSlotKey(slot.nodeId, slot.slot)) ||
        bindings.some(
          (binding) =>
            binding.nodeId === slot.nodeId && binding.slot === slot.slot,
        ),
    ) ?? false;
  const readyPreview =
    preview?.compatible && !preview.truncated && complete && !previewing
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
      await lifetime.verify({ signal: request.signal, creating: true });
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
    } catch (failure) {
      if (request.current() && epoch === intent.current)
        setError(
          failure instanceof Error
            ? failure.message
            : 'This file can’t be read. Choose a workflow file exported from Pertexo.',
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
      await lifetime.verify({ signal: request.signal, creating: true });
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
    if (!customName.current) setName(next.title);
    setBindings([]);
    // Destination literals must be supplied explicitly, never reused from demo data.
    setSetupValues(next.setupTargets.map(() => ''));
  }
  // An example that needs nothing filled in is checked as soon as it's
  // chosen, so Import is the next click; one with setup waits for values.
  const checkChosenExample = useEffectEvent(() => {
    void checkPreview();
  });
  const autoChecked = useRef<CuratedTemplate>(undefined);
  useEffect(() => {
    if (
      template === undefined ||
      template.setupTargets.length > 0 ||
      autoChecked.current === template
    )
      return;
    autoChecked.current = template;
    checkChosenExample();
  }, [template]);
  function changeName(next: string) {
    customName.current = next.trim() !== '';
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
    optionalSlots,
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
