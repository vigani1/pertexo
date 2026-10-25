import { assertSessionIdentity } from '@/features/auth/session/identity.public';
import { sendWorkflowOrganizationCommand } from '@/features/workflows/data/organization/api';
import { getAllAccessibleWorkspaces } from '@/features/workspaces/queries.public';
import { vi } from 'vitest';
import { user } from '../../list/fixtures';
import { receipt, session, workspace } from './fixture';
export function resetCommandMocks() {
  vi.clearAllMocks();
  session.listener = undefined;
  vi.mocked(assertSessionIdentity)
    .mockReset()
    .mockResolvedValue({ ...user, status: 'active' });
  vi.mocked(getAllAccessibleWorkspaces)
    .mockReset()
    .mockResolvedValue([workspace]);
  vi.mocked(sendWorkflowOrganizationCommand)
    .mockReset()
    .mockResolvedValue(receipt);
}
