import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  settingsQueryIsUnavailable,
  type SettingsQuery,
} from './settings-query';

export type { SettingsQuery } from './settings-query';

export function SettingsSection({
  title,
  description,
  children,
}: Readonly<{
  title: string;
  description: string;
  children: ReactNode;
}>) {
  return (
    <section className="glass-panel rounded-xl p-5 sm:p-6">
      <h2 className="font-heading text-xl font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      <div className="mt-5">{children}</div>
    </section>
  );
}

export function SettingsQueryState({
  query,
}: Readonly<{ query: SettingsQuery<unknown> }>) {
  if (query.isPending && query.data === undefined)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading…
      </p>
    );
  if (!query.isError) return null;
  const unavailable = settingsQueryIsUnavailable(query);
  return (
    <div>
      <p role="alert" className="text-sm text-destructive">
        {unavailable
          ? 'This section is unavailable.'
          : query.data === undefined
            ? 'This section could not be loaded.'
            : 'The latest refresh failed. Showing previously loaded data.'}
      </p>
      {unavailable ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => void query.refetch()}
        >
          Retry
        </Button>
      )}
    </div>
  );
}
