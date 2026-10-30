import { useRef } from 'react';
import {
  bodyDraft,
  applyBodyValue,
  validateBodyDraft,
  type HttpBodyDraft,
  type HttpBodyValue,
} from '../../../model/inspector/http-body';
import type { GraphLevel } from '../../../model/graph/scopes';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { useInspectorDraftField } from '../use-draft-field';

export function useHttpBodyDraft(
  value: HttpBodyValue,
  graph: GraphLevel,
  form: NodeFormApi,
) {
  const coalesce = useRef('');
  const reportScratch = form.reportScratch;
  const draft = useInspectorDraftField<HttpBodyValue, HttpBodyDraft>({
    value,
    format: bodyDraft,
    equals: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    parse: (text) => {
      const result = validateBodyDraft(text, graph, form.nodeId);
      return result.ok
        ? { ok: true, value: result.value }
        : { ok: false, error: result.error };
    },
    commit: (next) => {
      form.commit((current) => applyBodyValue(next, current), coalesce.current);
    },
    onScratchChange: (scratch) => {
      reportScratch('\u0000http-body', scratch);
    },
  });
  const validation = validateBodyDraft(draft.text, graph, form.nodeId);
  return {
    text: draft.text,
    validation,
    change: (text: HttpBodyDraft, key: string) => {
      coalesce.current = `${form.nodeId}:http-body:${key}`;
      draft.change(text);
    },
  };
}
