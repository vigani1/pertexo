import { XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function DismissibleFilterChip({
  label,
  removeLabel,
  onRemove,
}: Readonly<{ label: string; removeLabel: string; onRemove: () => void }>) {
  return (
    <Button
      variant="chip"
      size="sm"
      type="button"
      title={label}
      aria-label={removeLabel}
      className="min-w-0"
      onClick={onRemove}
    >
      <span className="min-w-0 truncate">{label}</span>
      <XIcon aria-hidden="true" className="size-3 shrink-0" />
    </Button>
  );
}
