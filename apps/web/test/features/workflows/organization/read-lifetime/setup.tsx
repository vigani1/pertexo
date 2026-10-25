import { assertSessionIdentity } from '@/features/auth/session/identity.public';
import {
  getWorkflowFolders,
  getWorkflowOrganizationPage,
  getWorkflowTagsPage,
  sendWorkflowOrganizationCommand,
} from '@/features/workflows/data/organization/api';
import { getAllAccessibleWorkspaces } from '@/features/workspaces/queries.public';
import { vi } from 'vitest';
import { user } from '../../list/fixtures';
import { folders, page, tags } from './fixture';
import { workspace } from './records';
export function resetReadMocks() {
  vi.mocked(assertSessionIdentity)
    .mockReset()
    .mockResolvedValue({ ...user, status: 'active' });
  vi.mocked(getAllAccessibleWorkspaces)
    .mockReset()
    .mockResolvedValue([workspace]);
  vi.mocked(sendWorkflowOrganizationCommand).mockReset();
  vi.mocked(getWorkflowOrganizationPage).mockReset().mockResolvedValue(page);
  vi.mocked(getWorkflowFolders).mockReset().mockResolvedValue(folders);
  vi.mocked(getWorkflowTagsPage).mockReset().mockResolvedValue(tags);
}
