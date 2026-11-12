import type {
  ImportDraftState,
  ImportDraftAction,
} from './workflow-import-state';
import type { RefObject, Dispatch } from 'react';
import type { WorkflowPortableManifest } from '@pertexo/workflow-model';
import type { ApiClient } from '@/lib/api/client';
import type { useFieldValidation } from '@/components/ui/use-field-validation';
import { describeCommandError } from '@/lib/api/error-copy';
import { workflowNameError } from '../model/rename';
import { readPortableWorkflowFile } from '../model/portability';
import { previewWorkflowImport } from '../data/portability/workflow-portability.api';
import type { usePortabilityLifetime } from '../components/portability/use-portability-lifetime';
import type { useWorkflowImportCommand } from '../data/portability/mutations';
import {
  setupValueError,
  templateOrigin,
} from '../model/templates/curated-setup';
export type ImportPhaseContext = Readonly<{
  draft: ImportDraftState;
  dispatch: Dispatch<ImportDraftAction>;
  apiClient: ApiClient;
  workspaceId: string;
  configuredManifest: WorkflowPortableManifest | undefined;
  complete: boolean;
  locked: boolean;
  lifetime: ReturnType<typeof usePortabilityLifetime>;
  command: ReturnType<typeof useWorkflowImportCommand>;
  validation: ReturnType<typeof useFieldValidation<string>>;
  sourceIntent: RefObject<number>;
  clear: () => void;
}>;

export function startAnotherImport({
  command,
  lifetime,
  clear,
  validation,
}: ImportPhaseContext) {
  if (command.state.kind !== 'confirmed' || lifetime.denied) return;
  clear();
  validation.reset();
}

export async function chooseImportFile(
  { dispatch, locked, validation, sourceIntent, lifetime }: ImportPhaseContext,
  file: File | undefined,
) {
  if (locked) return;
  dispatch({ type: 'file-chosen', reading: file !== undefined });
  validation.reset();
  if (file === undefined) return;
  const epoch = sourceIntent.current;
  const request = lifetime.begin();
  try {
    const parsed = await readPortableWorkflowFile(file);
    if (request.current() && epoch === sourceIntent.current)
      dispatch({ type: 'file-read', manifest: parsed });
  } catch (failure) {
    if (request.current() && epoch === sourceIntent.current)
      dispatch({
        type: 'file-read',
        error:
          failure instanceof Error
            ? failure.message
            : 'This file can’t be read. Choose a workflow file exported from Pertexo.',
      });
  } finally {
    request.done();
  }
}

export async function checkImportPreview({
  draft,
  dispatch,
  apiClient,
  command,
  workspaceId,
  complete,
  locked,
  validation,
  configuredManifest,
  lifetime,
}: ImportPhaseContext) {
  const { template, setupValues, name, bindings } = draft;
  const previewing = draft.activity === 'previewing';
  const setupErrors = Object.fromEntries(
    template?.setupTargets.map((target, index) => [
      `setup-${String(index)}`,
      setupValueError(target, setupValues[index] ?? ''),
    ]) ?? [],
  );
  const importSubmissionBlocked =
    !complete ||
    locked ||
    previewing ||
    !validation.submit({ name: workflowNameError(name), ...setupErrors });
  if (importSubmissionBlocked) return;
  if (configuredManifest === undefined) return;
  command.clear();
  const { revision } = draft;
  const request = lifetime.begin();
  dispatch({ type: 'preview-started' });
  try {
    if (!request.current()) return;
    const result = await previewWorkflowImport(
      apiClient,
      workspaceId,
      {
        manifest: configuredManifest,
        bindings,
        ...(template === undefined
          ? {}
          : { templateOrigin: templateOrigin(template) }),
      },
      request.signal,
    );
    if (request.current())
      dispatch({ type: 'preview-finished', revision, preview: result });
  } catch (failure) {
    if (!request.current()) return;
    dispatch(
      lifetime.accessFailure(failure)
        ? { type: 'preview-finished', revision, superseded: true }
        : {
            type: 'preview-finished',
            revision,
            error: describeCommandError(failure, 'checking this import'),
          },
    );
  } finally {
    request.done();
  }
}
