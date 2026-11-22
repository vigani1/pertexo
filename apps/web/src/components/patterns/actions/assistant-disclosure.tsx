import type { ReactNode } from 'react';
import { DialogDescription } from '@/components/ui/dialog';

export function AssistantDisclosure({
  destination,
  children,
  inDialog = true,
}: Readonly<{
  destination: { connectionName: string; host: string; model: string };
  children: ReactNode;
  inDialog?: boolean;
}>) {
  const content = (
    <>
      <span className="block">
        Send this request to <strong>{destination.connectionName}</strong> at{' '}
        <strong>{destination.host}</strong> using{' '}
        <strong>{destination.model}</strong>.
      </span>
      <span className="mt-3 block">{children}</span>
    </>
  );
  return inDialog ? (
    <DialogDescription>{content}</DialogDescription>
  ) : (
    <p className="text-sm leading-relaxed wrap-anywhere text-muted-foreground">
      {content}
    </p>
  );
}
