import type { ValueSource } from '@pertexo/workflow-model';
import type { GraphLevel } from '../../../model/graph/scopes';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import {
  ATTACHMENTS_KEY,
  attachmentsDraft,
  checkAttachments,
  sameAttachments,
  type AttachmentsDraft,
} from '../../../model/inspector/object-mappings/attachments';
import { useInspectorDraftField } from '../use-draft-field';

/**
 * The attachment rows under live apply: complete rows save as the step's one
 * `attachments` mapping; an unfinished row waits here as scratch.
 */
export function useAttachmentsDraft(
  source: ValueSource | undefined,
  graph: GraphLevel,
  form: NodeFormApi,
) {
  const draft = useInspectorDraftField<
    ValueSource | undefined,
    AttachmentsDraft
  >({
    value: source,
    format: attachmentsDraft,
    equals: sameAttachments,
    parse: (text) => {
      const checked = checkAttachments(text, graph, form.nodeId);
      if (checked.error !== undefined)
        return { ok: false, error: checked.error };
      if (Object.keys(checked.errors).length > 0)
        return { ok: false, error: 'Finish the attachments.' };
      return { ok: true, value: checked.mapping };
    },
    commit: (mapping) => {
      form.commit((current) => {
        const { [ATTACHMENTS_KEY]: _previous, ...others } =
          current.inputMappings;
        return {
          inputMappings:
            mapping === undefined
              ? others
              : { ...others, [ATTACHMENTS_KEY]: mapping },
        };
      }, `${form.nodeId}:attachments`);
    },
    onScratchChange: (scratch) => {
      form.reportScratch('\u0000attachments', scratch);
    },
  });
  const checked = checkAttachments(draft.text, graph, form.nodeId);
  return {
    text: draft.text,
    /** Shown once people leave an unfinished row, then until it's fixed. */
    shown: draft.error !== undefined,
    rowErrors: checked.errors,
    error: checked.error,
    change: draft.change,
    blur: draft.blur,
  } as const;
}
