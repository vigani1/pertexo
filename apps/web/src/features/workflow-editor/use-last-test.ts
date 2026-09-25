import type { PreviewRunSummary } from '@pertexo/contracts/schemas/node-testing';
import { useState } from 'react';
import { useEditorStoreApi } from './model/editor-store-context';

export type FinishedTest = Readonly<{
  nodeId: string;
  preview: PreviewRunSummary;
}>;

/** A finished test and the draft edit it was made after. */
export type RecordedTest = FinishedTest & Readonly<{ generation: number }>;

/**
 * The step test that finished last in this session. The bar under the canvas
 * shows it until the next edit to the draft; the step's Test tab keeps
 * showing its output when it opens again.
 */
export function useLastTest() {
  const store = useEditorStoreApi();
  const [last, setLast] = useState<RecordedTest>();
  return {
    last,
    record: (test: FinishedTest) => {
      setLast({ ...test, generation: store.getState().generation });
    },
  } as const;
}
