export const dataTablesProblems = {
  'data_table.stored_definition_invalid': {
    status: 500,
    title: 'Stored table definition is damaged',
    severity: 'error',
    exposeDetail: true,
  },
  'data_table.conflict': {
    status: 409,
    title: 'Data table changed',
    severity: 'info',
    exposeDetail: true,
  },
  'data_table.key_conflict': {
    status: 409,
    title: 'Unique key already used',
    severity: 'info',
    exposeDetail: true,
  },
  'data_table.quota_exceeded': {
    status: 409,
    title: 'Data table limit reached',
    severity: 'info',
    exposeDetail: true,
  },
  'export.already_running': {
    status: 409,
    title: 'An export is already running',
    severity: 'info',
    exposeDetail: true,
  },
} as const;
