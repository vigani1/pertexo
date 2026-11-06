interface ScheduleHealthObservation {
  next_fire_at: Date;
  status: string;
  misfire_policy: string;
  admission_deferred_until: Date | null;
  observed_at: Date;
}

export function decideScheduleHealthTransition(
  input: Readonly<{ enabled: boolean }>,
  target: ScheduleHealthObservation,
  nextOccurrence: () => Date,
) {
  let nextFireAt = target.next_fire_at;
  const enablesSkippedSchedule =
    input.enabled &&
    target.status === 'disabled' &&
    target.misfire_policy === 'skip';
  if (enablesSkippedSchedule) {
    nextFireAt = nextOccurrence();
  }
  const retainsAdmissionBackoff =
    input.enabled &&
    target.admission_deferred_until !== null &&
    target.admission_deferred_until.getTime() > target.observed_at.getTime();
  return Object.freeze({
    healthStatus: scheduleHealthStatus(input, { retainsAdmissionBackoff }),
    lastErrorCode: retainsAdmissionBackoff
      ? 'schedule.admission_throttled'
      : null,
    nextFireAt,
    scheduleStatus: input.enabled ? 'enabled' : 'disabled',
    triggerStatus: input.enabled ? 'active' : 'disabled',
  });
}

function scheduleHealthStatus(
  input: Readonly<{ enabled: boolean }>,
  { retainsAdmissionBackoff }: Readonly<{ retainsAdmissionBackoff: boolean }>,
): 'degraded' | 'disabled' | 'healthy' {
  if (input.enabled) {
    if (retainsAdmissionBackoff) {
      return 'degraded';
    }
    return 'healthy';
  }
  return 'disabled';
}
