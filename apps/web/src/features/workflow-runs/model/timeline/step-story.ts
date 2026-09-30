import type { StatusTone } from '@/components/ui/status';
import type { NodeStatus } from '../run-status';

// The shapes a step's story is told in: its thread segments, its entries
// and its outputs. `step-replay.ts` builds them from events.

export type RunTimelineEnd = 'knot' | 'fray' | 'bar' | 'cut' | 'gap';

export type RunTimelineSegment = Readonly<{
  kind: 'attempt' | 'wait' | 'skipped' | 'pending';
  tone: StatusTone;
  startMs: number;
  /** Null while open: the segment grows to "now". */
  endMs: number | null;
  end?: RunTimelineEnd;
}>;

export type StepOutcome =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'canceled'
  | 'outcome_unknown'
  | 'scheduled'
  | 'waiting'
  | 'skipped';

export type StepStoryEntry = Readonly<{
  /** The event that made it and its kind ("event-12:retry"), or "summary:…". */
  id: string;
  kind: 'attempt' | 'retry' | 'wait' | 'skipped';
  outcome: StepOutcome;
  tone: StatusTone;
  startedAt: string;
  attemptNumber?: number;
  endedAt?: string;
  dueAt?: string;
  safeErrorCode?: string;
  /** Why it ended this way, from the engine: "branch_failed", "network". */
  reasonCode?: string;
}>;

export type StepOutput =
  | Readonly<{ kind: 'artifact'; artifactId: string; attemptNumber?: number }>
  | Readonly<{ kind: 'inline'; attemptId: string; attemptNumber?: number }>;

export type StepReplay = Readonly<{
  segments: readonly RunTimelineSegment[];
  story: readonly StepStoryEntry[];
  outputs: readonly StepOutput[];
  attempts: number;
  status?: NodeStatus;
  safeErrorCode?: string;
  resumeAt?: string;
  nodeRunId?: string;
  firstActivityMs?: number;
}>;
