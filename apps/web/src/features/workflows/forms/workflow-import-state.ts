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
  activity: 'idle' | 'reading' | 'previewing';
  fileGeneration: number;
  /** Bumped by every source change; a preview belongs to one revision. */
  revision: number;
}>;

export type ImportSourceEdit =
  | Readonly<{ field: 'name'; value: string }>
  | Readonly<{ field: 'setup'; index: number; value: string }>
  | Readonly<{ field: 'bindings'; value: PortableConnectionBinding[] }>;

export type ImportDraftAction =
  | Readonly<{ type: 'reset'; name?: string }>
  /** `name` replaces the current one only when the person hasn't typed one. */
  | Readonly<{
      type: 'template-chosen';
      template: CuratedTemplate;
      name?: string;
    }>
  /** No file clears the source; a file starts reading it. */
  | Readonly<{ type: 'file-chosen'; reading: boolean }>
  | Readonly<
      | { type: 'file-read'; manifest: WorkflowPortableManifest }
      | { type: 'file-read'; error: string }
    >
  | Readonly<{ type: 'source-edited'; edit: ImportSourceEdit }>
  | Readonly<{ type: 'preview-started' }>
  /** `revision` is the source revision the check started from. */
  | Readonly<
      | {
          type: 'preview-finished';
          revision: number;
          preview: WorkflowImportPreviewResponse;
        }
      | { type: 'preview-finished'; revision: number; error: string }
      /** A closed session made this check irrelevant. */
      | { type: 'preview-finished'; revision: number; superseded: true }
    >
  /** A sent import consumed its preview; a new import is checked again. */
  | Readonly<{ type: 'import-sent' }>;

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
    revision: 0,
  };
}

/**
 * Each transition clears what it invalidates: any change to the source drops
 * the preview and its error, so no caller can leave a stale preview behind.
 */
export function importDraftReducer(
  state: ImportDraftState,
  action: ImportDraftAction,
): ImportDraftState {
  const unchecked = {
    ...state,
    preview: undefined,
    error: undefined,
    revision: state.revision + 1,
  };
  switch (action.type) {
    case 'reset':
      // A file control also needs a fresh identity to forget its file.
      return {
        ...initialImportDraft(action.name ?? ''),
        fileGeneration: state.fileGeneration + 1,
        revision: state.revision + 1,
      };
    case 'template-chosen':
      return {
        ...unchecked,
        template: action.template,
        manifest: structuredClone(action.template.manifest),
        name: action.name ?? state.name,
        bindings: [],
        // Destination literals are supplied explicitly, never reused from demo data.
        setupValues: action.template.setupTargets.map(() => ''),
        activity: 'idle',
      };
    case 'file-chosen':
      return {
        ...unchecked,
        template: undefined,
        setupValues: [],
        manifest: undefined,
        bindings: [],
        activity: action.reading ? 'reading' : 'idle',
      };
    case 'file-read':
      return 'manifest' in action
        ? { ...unchecked, manifest: action.manifest, activity: 'idle' }
        : { ...unchecked, error: action.error, activity: 'idle' };
    case 'source-edited':
      return { ...unchecked, ...sourceEdit(state, action.edit) };
    case 'preview-started':
      return {
        ...state,
        preview: undefined,
        error: undefined,
        activity: 'previewing',
      };
    case 'preview-finished':
      // An edit after the check started already cleared what it invalidated.
      if (action.revision !== state.revision || 'superseded' in action)
        return { ...state, activity: 'idle' };
      if ('preview' in action)
        return { ...state, preview: action.preview, activity: 'idle' };
      return { ...state, error: action.error, activity: 'idle' };
    case 'import-sent':
      return { ...state, preview: undefined };
  }
}

function sourceEdit(
  state: ImportDraftState,
  edit: ImportSourceEdit,
): Partial<ImportDraftState> {
  switch (edit.field) {
    case 'name':
      return { name: edit.value };
    case 'bindings':
      return { bindings: edit.value };
    case 'setup':
      return {
        setupValues: state.setupValues.map((value, index) =>
          index === edit.index ? edit.value : value,
        ),
      };
  }
}
