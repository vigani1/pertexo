export declare function liveJourneyEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
  journey: string,
): Record<string, string | undefined>;
export declare function failureArtifactJourney(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined;
