/**
 * Live journeys whose accounts exist only for the run, on a database the run
 * throws away, and whose pages show no secret typed into a step. Only these
 * keep a Playwright trace and screenshot of a failure; CI uploads them to a
 * public repository's artifacts, so every other journey keeps them off.
 */
const LIVE_FAILURE_ARTIFACT_JOURNEYS = Object.freeze([
  'callable',
  'workflow-organization-viewer',
  'workflow-organization-builder',
  'workflow-organization-admin',
]);

const NAME = 'PERTEXO_LIVE_FAILURE_ARTIFACTS';

/**
 * A journey child's environment: the parent's, minus any inherited request
 * for failure artifacts, plus this journey's own name when it is listed. An
 * exported variable can't turn traces on for another journey.
 */
export function liveJourneyEnvironment(parent, journey) {
  const environment = Object.fromEntries(
    Object.entries(parent).filter(([name]) => name !== NAME),
  );
  return LIVE_FAILURE_ARTIFACT_JOURNEYS.includes(journey)
    ? { ...environment, [NAME]: journey }
    : environment;
}

/** The listed journey the live config keeps failure artifacts for, if any. */
export function failureArtifactJourney(environment) {
  const journey = environment[NAME];
  if (journey === undefined) return undefined;
  if (!LIVE_FAILURE_ARTIFACT_JOURNEYS.includes(journey))
    throw new Error(
      `${NAME} must name a journey listed in infrastructure/testing/live-failure-artifacts.mjs.`,
    );
  return journey;
}
