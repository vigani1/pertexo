import { useState } from 'react';
import { VariableUsageDialog } from '@/features/workspace-variables/components/usage';
import { createApiClient } from '@/lib/api/client';
import { testFetch } from '../../../support/render-app';

export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export function DialogOpener({
  onRemove,
}: Readonly<{ onRemove?: () => void }>) {
  const [open, setOpen] = useState(false);
  const apiClient = createApiClient({
    fetch: testFetch,
    readCsrfToken: () => undefined,
  });
  if (!open)
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Find references
      </button>
    );
  return (
    <VariableUsageDialog
      scope={{ apiClient, userId: 'user', workspaceId }}
      name="RATE"
      onClose={() => {
        setOpen(false);
      }}
      {...(onRemove === undefined ? {} : { onRemove })}
    />
  );
}
