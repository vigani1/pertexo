export const artifactsProblems = {
  'artifact.too_large': {
    status: 413,
    title: 'File too large',
    severity: 'info',
    exposeDetail: true,
  },
  'artifact.upload_unavailable': {
    status: 404,
    title: 'Upload no longer available',
    severity: 'info',
    exposeDetail: true,
  },
  'artifact.conflict': {
    status: 409,
    title: 'Artifact conflict',
    severity: 'info',
    exposeDetail: true,
  },
  'artifact.unavailable': {
    status: 503,
    title: 'Artifact storage unavailable',
    severity: 'warn',
    exposeDetail: true,
  },
} as const;
