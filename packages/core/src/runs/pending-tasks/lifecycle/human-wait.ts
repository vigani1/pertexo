export type HumanWaitRun = Readonly<{
  status: string;
  cancel_requested_at: Date | null;
  deadline_expired: boolean;
}>;

export type HumanWaitFacts = Readonly<{
  all_human_waiting: boolean;
  has_human_wait: boolean;
  resume_work: boolean;
  lent_human_wait: boolean;
  has_running_or_timed_work: boolean;
  child_resume_work: boolean;
}>;

/** Only a live, uncancelled run within its deadline pauses or resumes its clock. */
export function humanWaitClockRunning(run: HumanWaitRun): boolean {
  return (
    ['running', 'waiting'].includes(run.status) &&
    run.cancel_requested_at === null &&
    !run.deadline_expired
  );
}

/**
 * Whether the run waits only on people. Completed Calls remain runnable work
 * until their parent consumes the result. A parent cannot execute ready
 * siblings while its slot is lent, so its clock stays paused until the
 * human-blocked child can resume, as with a lone Call.
 */
export function humanWaitQuiescent(facts: HumanWaitFacts): boolean {
  return (
    (facts.all_human_waiting && facts.has_human_wait && !facts.resume_work) ||
    (facts.lent_human_wait &&
      !facts.has_running_or_timed_work &&
      !facts.child_resume_work)
  );
}
