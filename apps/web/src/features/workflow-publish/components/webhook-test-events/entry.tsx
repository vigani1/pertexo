import { Suspense } from 'react';
import { lazyPiece } from '@/components/patterns/app-update/lazy';
import type { SampleScope } from '../../data/samples/api';
const Panel = lazyPiece(() =>
  import('./panel').then((module) => module.WebhookTestEventPanel),
);
export function WebhookTestListener(
  props: Readonly<{
    scope: SampleScope;
    nodeId: string;
    binding: string | undefined;
    ensureSaved: () => Promise<{ revision: number }>;
    active: boolean;
  }>,
) {
  return (
    <Suspense fallback={<p role="status">Loading webhook test…</p>}>
      <Panel {...props} />
    </Suspense>
  );
}
