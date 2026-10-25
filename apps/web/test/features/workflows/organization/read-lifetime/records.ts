import { createApiClient } from '@/lib/api/client';
import { accessibleWorkspaceSchema } from '@pertexo/contracts';
import { vi } from 'vitest';
import { workspaceWith } from '../../list/fixtures';
export const apiClient = createApiClient({
  fetch: vi.fn(),
  readCsrfToken: () => undefined,
});

export const folderId = '11111111-1111-4111-8111-111111111111';

export const tagId = '22222222-2222-4222-8222-222222222222';

export const workspace = accessibleWorkspaceSchema.parse(workspaceWith([]));
