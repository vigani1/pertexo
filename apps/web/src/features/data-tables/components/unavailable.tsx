import { Notice } from '@/components/ui/notice';

export function UnavailableDataTable({ name }: Readonly<{ name: string }>) {
  return (
    <Notice tone="warning">
      <p className="font-medium">{name} — unavailable</p>
      <p>
        A stored table definition is damaged. Ask the workspace owner to restore
        it from a backup. Other tables can still be read and exported.
      </p>
    </Notice>
  );
}
