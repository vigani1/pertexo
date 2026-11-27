import { workspaceId } from '../../workflow-editor/support';

// Complete, contract-valid answers for the workspace pages' screenshots.

const hour = 3_600_000;
export const at = (offsetHours: number) =>
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
    isCurrentPublication: true,
    operationKeys: ['http.request'],
  })),
  nextCursor: null,
};
