/** Build's search when it opens on the guided first run. */
export type FirstRunGuideSearch = Readonly<{ guide?: 'first-run' }>;

export function parseFirstRunGuideSearch(
  search: Record<string, unknown>,
): FirstRunGuideSearch {
  return search.guide === 'first-run' ? { guide: 'first-run' } : {};
}

export type FirstRunGuideStep = Readonly<{
  key: 'publish' | 'run' | 'watch';
  label: string;
  hint: string;
  done: boolean;
}>;

/** The guided first run, from what is known of the workflow so far. */
export function firstRunGuideSteps(published: boolean): FirstRunGuideStep[] {
  return [
    {
      key: 'publish',
      label: 'Publish it',
      hint: 'Select Publish at the top. Publishing freezes this version so it can run.',
      done: published,
    },
    {
      key: 'run',
      label: 'Run it',
      hint: 'Open Run and choose Run published version. Nothing outside Pertexo is called.',
      done: false,
    },
    {
      key: 'watch',
      label: 'Watch it finish',
      hint: 'The run opens on its timeline, with what each step made.',
      done: false,
    },
  ];
}
