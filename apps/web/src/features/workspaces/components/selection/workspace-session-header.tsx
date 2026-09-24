import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function WorkspaceSessionHeader({
  email,
  logoutPending,
  onLogout,
}: Readonly<{
  email: string;
  logoutPending: boolean;
  onLogout: () => void;
}>) {
  return (
    <header className="workspace-session-header">
      <span className="workspace-wordmark">Pertexo</span>
      <span className="sr-only">Signed in as</span>
      <span className="sr-only">{email}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={logoutPending}
        onClick={onLogout}
      >
        <LogOut aria-hidden="true" />
        {logoutPending ? 'Signing out…' : 'Sign out'}
      </Button>
    </header>
  );
}
