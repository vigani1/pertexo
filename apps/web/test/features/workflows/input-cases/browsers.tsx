import { InputCasesAction } from '@/features/workflows/components/input-cases/action';
import { InputCasesPanel } from '@/features/workflows/workflows-views.public';
import { useInputCases } from '@/features/workflows/public';
import type { createApiClient } from '@/lib/api/client';
import { useState, type ComponentProps } from 'react';
export function InputCasesActionHarness(
  props: Omit<ComponentProps<typeof InputCasesAction>, 'open' | 'onOpenChange'>,
) {
  const [open, setOpen] = useState(false);
  return <InputCasesAction {...props} open={open} onOpenChange={setOpen} />;
}

export function CaseBrowser(
  props: Omit<React.ComponentProps<typeof InputCasesPanel>, 'cases'> &
    Readonly<{ apiClient: ReturnType<typeof createApiClient>; userId: string }>,
) {
  const cases = useInputCases({
    api: props.apiClient,
    userId: props.userId,
    workspaceId: props.scope.workspace.id,
    workflowId: props.scope.workflow.id,
    canWrite: props.scope.workspace.capabilities.includes('workflow:update'),
  });
  return <InputCasesPanel {...props} cases={cases} />;
}
