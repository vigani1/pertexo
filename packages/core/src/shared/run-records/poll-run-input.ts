import type { JsonValue } from '@pertexo/workflow-model';

/** The inline run input persisted by the ordinary execution-value codec. */
export type PollRunInput = Readonly<{
  triggerId: string;
  nodeId: string;
  item: JsonValue;
}>;
