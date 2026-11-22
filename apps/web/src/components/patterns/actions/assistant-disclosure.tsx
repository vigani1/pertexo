import type { ReactNode } from 'react';
import { DialogDescription } from '@/components/ui/dialog';

export function AssistantDisclosure({
  destination,
  children,
}: Readonly<{
  destination: { connectionName: string; host: string; model: string };
  children: ReactNode;
}>) {
  return (
    <DialogDescription>
      <span className="block">
        Send this request to <strong>{destination.connectionName}</strong> at{' '}
        <strong>{destination.host}</strong> using{' '}
        <strong>{destination.model}</strong>.
      </span>
      <span className="mt-3 block">{children}</span>
    </DialogDescription>
  );
}
