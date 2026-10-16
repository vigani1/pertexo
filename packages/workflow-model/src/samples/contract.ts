export type StepSampleSource =
  | Readonly<{ kind: 'json'; value: unknown }>
  | Readonly<{ kind: 'preview'; previewRunId: string }>
  | Readonly<{ kind: 'run'; runId: string; nodeRunId: string }>
  | Readonly<{ kind: 'confirm' }>;
