import type { PreviewRunSummary } from '@pertexo/contracts';
import { createContext, use, useState } from 'react';
import { useEditorStore, useEditorStoreApi } from '../model/state/context';

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

/** The session's last finished test, for setups that preview its output. */
export const LastTestContext = createContext<RecordedTest | undefined>(
  undefined,
);

/** One step's last finished test, and whether the draft changed after it. */
export function useStepLastTest(nodeId: string) {
  const last = use(LastTestContext);
  const generation = useEditorStore((state) => state.generation);
  if (last?.nodeId !== nodeId) return undefined;
  return {
    preview: last.preview,
    stale: last.generation !== generation,
  } as const;
}
