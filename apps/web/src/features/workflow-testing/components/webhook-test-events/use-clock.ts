import type { WebhookTestEventSnapshot } from '@pertexo/contracts';
import { useNow } from '@/lib/hooks/use-now';
/** A listener opened after the idle clock last ticked starts from its own receipt time. */
export function useListenerClock({
  listener,
  snapshot,
  active,
}: Readonly<{
  listener: Readonly<{ expiresAt: string; openedAtMillis: number }> | undefined;
  snapshot: WebhookTestEventSnapshot | undefined;
  active: boolean;
}>) {
  const expiresAt =
    listener === undefined
      ? undefined
      : Date.parse(snapshot?.expiresAt ?? listener.expiresAt);
  const now = Math.max(
    useNow({
      intervalMs: 1000,
      enabled: active && listener !== undefined,
      untilMs: expiresAt,
    }),
    listener?.openedAtMillis ?? 0,
  );
  return { now, expiresAt };
}
