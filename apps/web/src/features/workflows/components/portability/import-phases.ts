import type { RefObject, Dispatch, SetStateAction } from 'react';
import type { WorkflowImportPreviewResponse } from '@pertexo/contracts';
import type {
  PortableConnectionBinding,
  WorkflowPortableManifest,
} from '@pertexo/workflow-model';
import type { ApiClient } from '@/lib/api/client';
import type { useFieldValidation } from '@/components/ui/use-field-validation';
import { describeCommandError } from '@/lib/api/error-copy';
import { workflowNameError } from '../../model/rename';
import { readPortableWorkflowFile } from '../../model/portability';
import { previewWorkflowImport } from '../../data/portability/api';
import type { usePortabilityLifetime } from './use-lifetime';
import type { useWorkflowImportCommand } from '../../data/portability/mutations';
import {
  setupValueError,
  templateOrigin,
  type CuratedTemplate,
} from '../../model/templates/curated-setup';
export type ImportPhaseContext = Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  template: CuratedTemplate | undefined;
  setupValues: readonly string[];
  configuredManifest: WorkflowPortableManifest | undefined;
  name: string;
  bindings: PortableConnectionBinding[];
  complete: boolean;
  locked: boolean;
  previewing: boolean;
  lifetime: ReturnType<typeof usePortabilityLifetime>;
  command: ReturnType<typeof useWorkflowImportCommand>;
  validation: ReturnType<typeof useFieldValidation<string>>;
  intent: RefObject<number>;
  resetBusy: RefObject<boolean>;
  clear: () => void;
  invalidate: () => void;
  setManifest: Dispatch<SetStateAction<WorkflowPortableManifest | undefined>>;
  setTemplate: Dispatch<SetStateAction<CuratedTemplate | undefined>>;
  setSetupValues: Dispatch<SetStateAction<string[]>>;
  setBindings: Dispatch<SetStateAction<PortableConnectionBinding[]>>;
  setReading: (value: boolean) => void;
  setPreview: (value: WorkflowImportPreviewResponse | undefined) => void;
  setError: (value: string | undefined) => void;
  setResetting: (value: boolean) => void;
  setPreviewing: (value: boolean) => void;
}>;

export async function startAnotherImport({
  command,
  lifetime,
  resetBusy,
  setResetting,
  clear,
  validation,
  setError,
}: ImportPhaseContext) {
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

export async function chooseImportFile(
  {
    locked,
    invalidate,
    setTemplate,
    setSetupValues,
    setManifest,
    setBindings,
    setReading,
    validation,
    intent,
    lifetime,
    setError,
  }: ImportPhaseContext,
  file: File | undefined,
) {
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

export async function checkImportPreview({
  apiClient,
  workspaceId,
  template,
  setupValues,
  complete,
  locked,
  previewing,
  validation,
  name,
  configuredManifest,
  intent,
  lifetime,
  setPreview,
  setError,
  setPreviewing,
  bindings,
}: ImportPhaseContext) {
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
