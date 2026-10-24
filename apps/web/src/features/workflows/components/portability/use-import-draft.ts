import {
  startAnotherImport,
  chooseImportFile,
  checkImportPreview,
  type ImportPhaseContext,
} from './import-phases';
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
  NodeDefinitionCatalogItem,
  WorkflowImportPreviewResponse,
} from '@pertexo/contracts';
import type {
  PortableConnectionBinding,
  WorkflowPortableManifest,
} from '@pertexo/workflow-model';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import type { ApiClient } from '@/lib/api/client';
import { workflowNameError } from '../../model/rename';
import {
  connectionSlotKey,
  optionalConnectionSlots,
} from '../../model/portability';
import { authoringCatalogQueryOptions } from '@/features/catalog/queries.public';
import { usePortabilityLifetime } from './use-lifetime';
import { useWorkflowImportCommand } from '../../data/portability/mutations';
import {
  configureTemplate,
  templateOrigin,
  type CuratedTemplate,
} from '../../model/templates/curated-setup';

/** Owns source edits, preview validity and the lifetime of a retained import. */
// eslint-disable-next-line max-lines-per-function -- Keep the single import form and retry owner together; async phases live in import-phases.
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
  const { optionalSlots, complete } = importConnectionSetup(
    manifest,
    catalog.data?.definitions.items,
    bindings,
  );
  const previewReady =
    preview?.compatible && !preview.truncated && complete && !previewing;
  const readyPreview = previewReady ? preview : undefined;
  const context: ImportPhaseContext = {
    apiClient,
    workspaceId: workspace.id,
    template,
    setupValues,
    configuredManifest,
    name,
    bindings,
    complete,
    locked,
    previewing,
    lifetime,
    command,
    validation,
    intent,
    resetBusy,
    clear,
    invalidate,
    setManifest,
    setTemplate,
    setSetupValues,
    setBindings,
    setReading,
    setPreview,
    setError,
    setResetting,
    setPreviewing,
  };
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
  const startAnother = () => startAnotherImport(context);
  function invalidate() {
    intent.current += 1;
    setPreview(undefined);
    setError(undefined);
  }
  const chooseFile = (file: File | undefined) =>
    chooseImportFile(context, file);
  const checkPreview = () => checkImportPreview(context);
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

function importConnectionSetup(
  manifest: WorkflowPortableManifest | undefined,
  definitions: readonly NodeDefinitionCatalogItem[] | undefined,
  bindings: readonly PortableConnectionBinding[],
) {
  const optionalSlots =
    manifest === undefined || definitions === undefined
      ? new Set<string>()
      : optionalConnectionSlots(manifest, definitions);
  const complete =
    manifest?.connectionSlots.every(
      (slot) =>
        optionalSlots.has(connectionSlotKey(slot.nodeId, slot.slot)) ||
        bindings.some(
          (binding) =>
            binding.nodeId === slot.nodeId && binding.slot === slot.slot,
        ),
    ) ?? false;
  return { optionalSlots, complete };
}
