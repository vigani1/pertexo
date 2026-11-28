import { workspaceId } from '../../workflow-editor/support';

// Complete, contract-valid answers for the workspace pages' screenshots.

const hour = 3_600_000;
const at = (offsetHours: number) =>
  new Date(Date.now() + offsetHours * hour).toISOString();
const id = (group: number, index: number) =>
  `${String(group).padStart(8, '6')}-0000-4000-8000-${String(index).padStart(12, '0')}`;

const authTypes = {
  slack: 'slack_bot_token',
  http: 'http_headers',
  email: 'resend_api_key',
} as const;

function connection(
  index: number,
  name: string,
  providerKey: keyof typeof authTypes,
  status: 'active' | 'reauthorization_required' = 'active',
) {
  return {
    id: id(6, index),
    workspaceId,
    providerKey,
    name,
    authType: authTypes[providerKey],
    status,
    secretVersionId: id(7, index),
    health: {
      lastTestedAt: at(-3),
      lastHealthyAt: status === 'active' ? at(-1) : at(-4),
      lastErrorCode:
        status === 'active' ? null : 'connection.credential_rejected',
      lastRunObservedAt: at(-1),
      lastHealthTransitionAt: at(-3.5),
      lastHealthTransitionSource: 'run',
    },
    createdAt: at(-24 * 50),
    updatedAt: at(-3),
  };
}

export const connections = [
  connection(1, 'ERP API', 'http'),
  connection(2, 'Slack finance', 'slack', 'reauthorization_required'),
  connection(3, 'Resend receipts', 'email'),
  connection(4, 'HubSpot CRM', 'http'),
  connection(5, 'Partner portal', 'http'),
  connection(6, 'Ops alerts', 'slack'),
];

const workflowNames = [
  'Hourly stock sync',
  'Warehouse restock',
  'Supplier reminders',
  'Price list import',
  'Nightly CRM sync',
  'Month-end close',
  'Invoice intake',
  'Refund approvals',
  'Customer onboarding',
  'Contract renewals',
  'Order export',
  'Returns triage',
];

export const connectionUsage = {
  items: workflowNames.map((workflowName, index) => ({
    workflowId: id(8, index + 1),
    workflowName,
    workflowLifecycleStatus: 'active',
    workflowVersionId: id(9, index + 1),
    versionNumber: (index % 4) + 1,
    isCurrentPublication: index < 8,
    operationKeys: ['http.request'],
  })),
  nextCursor: null,
};

function table({
  index,
  name,
  keyColumn,
  rowCount,
  columns,
}: Readonly<{
  index: number;
  name: string;
  keyColumn: string | null;
  rowCount: number;
  columns: readonly (readonly [string, 'text' | 'number' | 'boolean'])[];
}>) {
  return {
    id: id(5, index),
    name,
    columns: columns.map(([column, type]) => ({
      id: column,
      name: column,
      type,
      required: column === keyColumn,
    })),
    keyColumn,
    hasRemovedColumns: false,
    rowCount,
    storedBytes: rowCount * 240,
    revision: 1,
  };
}

export const tables = [
  table({
    index: 1,
    name: 'Restock thresholds',
    keyColumn: 'sku',
    rowCount: 412,
    columns: [
      ['sku', 'text'],
      ['product', 'text'],
      ['on_hand', 'number'],
      ['reorder_qty', 'number'],
      ['active', 'boolean'],
    ],
  }),
  table({
    index: 2,
    name: 'Invoice ledger',
    keyColumn: null,
    rowCount: 8640,
    columns: [
      ['invoice', 'text'],
      ['amount', 'number'],
    ],
  }),
  table({
    index: 3,
    name: 'Supplier contacts',
    keyColumn: 'supplier_id',
    rowCount: 38,
    columns: [
      ['supplier_id', 'text'],
      ['email', 'text'],
    ],
  }),
  table({
    index: 4,
    name: 'Partner endpoints',
    keyColumn: 'partner_id',
    rowCount: 21,
    columns: [
      ['partner_id', 'text'],
      ['url', 'text'],
    ],
  }),
  table({
    index: 5,
    name: 'Holiday calendar',
    keyColumn: 'date',
    rowCount: 14,
    columns: [
      ['date', 'text'],
      ['name', 'text'],
    ],
  }),
];

export const tableQuotas = {
  tableLimit: 20,
  columnLimit: 20,
  rowLimit: 10000,
  byteLimit: 52428800,
  tableCount: tables.length,
  storedBytes: tables.reduce((sum, item) => sum + item.storedBytes, 0),
};

const products = [
  'Oat milk 1 L',
  'Espresso beans',
  'Paper cups',
  'Lids',
  'Napkins',
  'Sugar sticks',
];

export const tableRows = {
  rows: products.map((product, index) => ({
    id: id(4, index + 1),
    values: {
      sku: `SKU-${String(1040 + index)}`,
      product,
      on_hand: 40 + index * 17,
      reorder_qty: 120,
      active: index !== 3,
    },
    revision: 1,
  })),
  affected: products.length,
  hasMore: false,
};

const people: readonly (readonly [
  string,
  'owner' | 'admin' | 'builder' | 'operator' | 'viewer',
])[] = [
  ['Pertexo Operator', 'owner'],
  ['Iris Lund', 'admin'],
  ['Marco Vitale', 'admin'],
  ...[
    'Sami Haddad',
    'Priya Nair',
    'Jonas Berg',
    'Lea Moreau',
    'Tomás Rivera',
    'Hana Sato',
    'Omar Aziz',
    'Ines Costa',
  ].map((name) => [name, 'builder'] as const),
  ['Ruth Adler', 'operator'],
  ['Kofi Mensah', 'operator'],
  ['Mei Chen', 'viewer'],
];

export function members(ownerId: string) {
  return {
    items: people.map(([displayName, role], index) => ({
      userId: index === 0 ? ownerId : id(3, index + 1),
      email: `${displayName.split(' ')[0]?.toLowerCase() ?? 'person'}@northwind.example`,
      displayName,
      role,
      roleRevision: 1,
      membershipStatus: index === 12 ? 'suspended' : 'active',
      createdAt: at(-24 * (300 - index * 11)),
      updatedAt: at(-24 * 2),
    })),
    nextCursor: null,
  };
}

export const invitations = {
  issuanceAvailable: true,
  items: ['ana@northwind.example', 'ben@northwind.example'].map(
    (email, index) => ({
      id: id(2, index + 1),
      email,
      role: 'builder',
      status: 'pending',
      revision: 1,
      deliveryStatus: 'submitted',
      expiresAt: at(24 * 6),
      createdAt: at(-24),
      updatedAt: at(-24),
    }),
  ),
  nextCursor: null,
};
