import {
  importDraftReducer,
  initialImportDraft,
} from './workflow-import-state';
import {
  startAnotherImport,
  chooseImportFile,
  checkImportPreview,
  type ImportPhaseContext,
} from './workflow-import-phases';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useReducer,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  AccessibleWorkspace,
  NodeDefinitionCatalogItem,
} from '@pertexo/contracts';
import type {
  PortableConnectionBinding,
  WorkflowPortableManifest,
} from '@pertexo/workflow-model';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import type { ApiClient } from '@/lib/api/client';
import { workflowNameError } from '../model/rename';
import {
  connectionSlotKey,
  optionalConnectionSlots,
} from '../model/portability';
import { authoringCatalogQueryOptions } from '@/features/catalog/catalog-queries.public';
import { usePortabilityLifetime } from '../components/portability/use-portability-lifetime';
import { useWorkflowImportCommand } from '../data/portability/mutations';
import {
  configureTemplate,
  templateOrigin,
  type CuratedTemplate,
} from '../model/templates/curated-setup';

/** Owns source edits, preview validity and the lifetime of a retained import. */
// eslint-disable-next-line max-lines-per-function -- Keep the single import form and retry owner together; async phases live in import-phases.
export function useImportDraft(
  apiClient: ApiClient,
  userId: string,
  workspace: AccessibleWorkspace,
  initialName = '',
) {
  const [draft, dispatch] = useReducer(
    importDraftReducer,
    initialName,
    initialImportDraft,
  );
  const {
    template,
    setupValues,
    manifest,
    name,
    bindings,
    preview,
    error,
    fileGeneration,
  } = draft;
  const reading = draft.activity === 'reading';
  const previewing = draft.activity === 'previewing';
  const resetting = draft.activity === 'resetting';
  const customName = useRef(initialName.trim() !== '');
  const resetBusy = useRef(false);
  const intent = useRef(0);
  const sourceIntent = useRef(0);
  const commandClear = useRef<() => void>(() => undefined);
  const validation = useFieldValidation<string>();
  const clear = useCallback(() => {
    intent.current += 1;
    sourceIntent.current += 1;
    dispatch({ type: 'reset' });
    customName.current = false;
    commandClear.current();
  }, []);
  const lifetime = usePortabilityLifetime(apiClient, userId, workspace.id, {
    clear,
    readScope: 'collection',
  });
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
    draft,
    dispatch,
    apiClient,
    workspaceId: workspace.id,
    configuredManifest,
    complete,
    locked,
    lifetime,
    command,
    validation,
    intent,
    sourceIntent,
    resetBusy,
    clear,
    invalidate,
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
      dispatch({ type: 'update', patch: { preview: undefined } });
    }
  }
  const startAnother = () => startAnotherImport(context);
  function invalidate() {
    intent.current += 1;
    dispatch({ type: 'update', patch: { preview: undefined } });
    dispatch({ type: 'update', patch: { error: undefined } });
  }
  const chooseFile = (file: File | undefined) => {
    sourceIntent.current += 1;
    return chooseImportFile(context, file);
  };
  const checkPreview = () => checkImportPreview(context);
  function chooseTemplate(next: CuratedTemplate) {
    if (locked) return;
    sourceIntent.current += 1;
    invalidate();
    validation.reset();
    dispatch({ type: 'update', patch: { template: next } });
    dispatch({ type: 'activity', activity: 'idle' });
    dispatch({
      type: 'update',
      patch: { manifest: structuredClone(next.manifest) },
    });
    if (!customName.current)
      dispatch({ type: 'update', patch: { name: next.title } });
    dispatch({ type: 'update', patch: { bindings: [] } });
    // Destination literals must be supplied explicitly, never reused from demo data.
    dispatch({
      type: 'update',
      patch: { setupValues: next.setupTargets.map(() => '') },
    });
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
    dispatch({ type: 'update', patch: { name: next } });
  }
  function changeSetup(index: number, next: string) {
    invalidate();
    dispatch({
      type: 'setup-values',
      update: (current) =>
        current.map((value, position) => (position === index ? next : value)),
    });
  }
  function changeBindings(next: PortableConnectionBinding[]) {
    invalidate();
    dispatch({ type: 'update', patch: { bindings: next } });
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
    resetSource: (name: string) => {
      if (locked) return;
      clear();
      dispatch({ type: 'update', patch: { name: name } });
      customName.current = name.trim() !== '';
    },
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
