import type { WorkflowImportPreviewResponse } from '@pertexo/contracts';
import type {
  PortableConnectionBinding,
  WorkflowPortableManifest,
} from '@pertexo/workflow-model';
import type { CuratedTemplate } from '../model/templates/curated-setup';

export type ImportDraftState = Readonly<{
  template: CuratedTemplate | undefined;
  setupValues: string[];
  manifest: WorkflowPortableManifest | undefined;
  name: string;
  bindings: PortableConnectionBinding[];
  preview: WorkflowImportPreviewResponse | undefined;
  error: string | undefined;
  activity: 'idle' | 'reading' | 'previewing' | 'resetting';
  fileGeneration: number;
}>;
export type ImportDraftAction =
  | Readonly<{ type: 'reset' }>
  | Readonly<{
      type: 'update';
      patch: Partial<Omit<ImportDraftState, 'activity' | 'fileGeneration'>>;
    }>
  | Readonly<{ type: 'activity'; activity: ImportDraftState['activity'] }>
  | Readonly<{ type: 'setup-values'; update: (current: string[]) => string[] }>;

export function initialImportDraft(name: string): ImportDraftState {
  return {
    template: undefined,
    setupValues: [],
    manifest: undefined,
    name,
    bindings: [],
    preview: undefined,
    error: undefined,
    activity: 'idle',
    fileGeneration: 0,
  };
}

/** Reset the complete form atomically; a file control also needs a fresh identity. */
export function importDraftReducer(
  state: ImportDraftState,
  action: ImportDraftAction,
): ImportDraftState {
  switch (action.type) {
    case 'reset':
      return {
        ...initialImportDraft(''),
        fileGeneration: state.fileGeneration + 1,
      };
    case 'update':
      return { ...state, ...action.patch };
    case 'activity':
      return { ...state, activity: action.activity };
    case 'setup-values':
      return { ...state, setupValues: action.update(state.setupValues) };
  }
}
