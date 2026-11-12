import { describe, expect, it } from 'vitest';
import {
  importDraftReducer,
  initialImportDraft,
} from '@/features/workflows/forms/workflow-import-state';

describe('import form reset', () => {
  it('clears source edits, setup, errors and in-flight presentation together and replaces the file control', () => {
    const edited = importDraftReducer(initialImportDraft('Example'), {
      type: 'update',
      patch: {
        setupValues: ['a destination'],
        bindings: [
          { nodeId: 'send', slot: 'account', connectionId: 'connection' },
        ],
        error: 'Unreadable file',
      },
    });
    const reading = importDraftReducer(edited, {
      type: 'activity',
      activity: 'reading',
    });
    const reset = importDraftReducer(reading, { type: 'reset' });
    expect(reset).toEqual({
      template: undefined,
      setupValues: [],
      manifest: undefined,
      name: '',
      bindings: [],
      preview: undefined,
      error: undefined,
      activity: 'idle',
      fileGeneration: 1,
    });
    expect(importDraftReducer(reset, { type: 'reset' }).fileGeneration).toBe(2);
  });
});
