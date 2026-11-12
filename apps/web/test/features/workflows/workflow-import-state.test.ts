import { describe, expect, it } from 'vitest';
import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';
import { workflowImportPreviewResponseSchema } from '@pertexo/contracts';
import {
  importDraftReducer,
  initialImportDraft,
  type ImportDraftAction,
  type ImportDraftState,
} from '@/features/workflows/forms/workflow-import-state';
import { preview as previewBody } from './portability/fixture';

const template = setupTemplate();
const preview = workflowImportPreviewResponseSchema.parse(previewBody);

function run(state: ImportDraftState, ...actions: ImportDraftAction[]) {
  return actions.reduce(importDraftReducer, state);
}

/** A chosen example, checked and ready to import. */
function checked(name = 'Example') {
  const chosen = run(initialImportDraft(name), {
    type: 'template-chosen',
    template,
  });
  return run(
    chosen,
    { type: 'preview-started' },
    { type: 'preview-finished', revision: chosen.revision, preview },
  );
}

describe('import form transitions', () => {
  it('keeps a finished preview for the source it checked', () => {
    const state = checked();
    expect(state.preview).toEqual(preview);
    expect(state.activity).toBe('idle');
  });

  it.each<ImportDraftAction>([
    { type: 'source-edited', edit: { field: 'name', value: 'Renamed' } },
    { type: 'source-edited', edit: { field: 'setup', index: 0, value: 'x' } },
    {
      type: 'source-edited',
      edit: {
        field: 'bindings',
        value: [{ nodeId: 'send', slot: 'account', connectionId: 'c' }],
      },
    },
    { type: 'template-chosen', template },
    { type: 'file-chosen', reading: true },
    { type: 'file-read', error: 'Unreadable file' },
  ])('drops the preview when the source changes: $type', (edit) => {
    expect(run(checked(), edit).preview).toBeUndefined();
  });

  it('ignores a preview that finishes after the source changed', () => {
    const chosen = run(initialImportDraft(''), {
      type: 'template-chosen',
      template,
    });
    const started = run(chosen, { type: 'preview-started' });
    const edited = run(started, {
      type: 'source-edited',
      edit: { field: 'name', value: 'Changed while checking' },
    });
    const finished = run(edited, {
      type: 'preview-finished',
      revision: chosen.revision,
      preview,
    });
    expect(finished.preview).toBeUndefined();
    expect(finished.activity).toBe('idle');
    expect(finished.name).toBe('Changed while checking');
  });

  it('starts a check without the previous preview or error', () => {
    const failed = run(checked(), {
      type: 'preview-finished',
      revision: checked().revision,
      error: 'Unavailable',
    });
    const restarted = run(failed, { type: 'preview-started' });
    expect(restarted.preview).toBeUndefined();
    expect(restarted.error).toBeUndefined();
    expect(restarted.activity).toBe('previewing');
  });

  it('sets an example up with blank destinations and a name only when none was typed', () => {
    const typed = run(initialImportDraft('My own name'), {
      type: 'template-chosen',
      template,
    });
    expect(typed.name).toBe('My own name');
    expect(typed.setupValues).toEqual(template.setupTargets.map(() => ''));
    expect(typed.manifest).toEqual(template.manifest);
    expect(typed.manifest).not.toBe(template.manifest);
    const named = run(initialImportDraft(''), {
      type: 'template-chosen',
      template,
      name: template.title,
    });
    expect(named.name).toBe(template.title);
  });

  it('clears the example when a file is chosen and reads it', () => {
    const reading = run(checked(), { type: 'file-chosen', reading: true });
    expect(reading).toMatchObject({
      template: undefined,
      setupValues: [],
      manifest: undefined,
      bindings: [],
      activity: 'reading',
    });
    const read = run(reading, {
      type: 'file-read',
      manifest: template.manifest,
    });
    expect(read).toMatchObject({
      manifest: template.manifest,
      activity: 'idle',
    });
  });

  it('consumes the preview once the import is sent', () => {
    const sent = run(checked(), { type: 'import-sent' });
    expect(sent.preview).toBeUndefined();
    expect(sent.name).toBe('Example');
  });

  it('resets everything together and replaces the file control', () => {
    const reading = run(checked(), { type: 'file-chosen', reading: true });
    const reset = run(reading, { type: 'reset', name: 'Kept' });
    expect(reset).toMatchObject({
      template: undefined,
      setupValues: [],
      manifest: undefined,
      name: 'Kept',
      bindings: [],
      preview: undefined,
      error: undefined,
      activity: 'idle',
      fileGeneration: 1,
    });
    expect(run(reset, { type: 'reset' }).fileGeneration).toBe(2);
  });
});

function setupTemplate() {
  const found = CURATED_WORKFLOW_TEMPLATES.find(
    (item) => item.setupTargets.length > 0,
  );
  if (found === undefined) throw new Error('Expected a template with setup');
  return found;
}
