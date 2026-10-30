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
      if (checked.ok) return { ok: true, value: checked.mapping };
      return {
        ok: false,
        error: 'error' in checked ? checked.error : 'Finish the attachments.',
      };
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
    rowErrors: !checked.ok && 'rowErrors' in checked ? checked.rowErrors : {},
    error: !checked.ok && 'error' in checked ? checked.error : undefined,
    change: draft.change,
    blur: draft.blur,
  } as const;
}
