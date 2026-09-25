import { HeadContent, Outlet } from '@tanstack/react-router';
import { NotificationsProvider } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';
import { NavigationProgress } from './navigation-progress';

export function RootLayout() {
  return (
    <NotificationsProvider>
      <TooltipProvider delay={400}>
        <HeadContent />
        <NavigationProgress />
        <a
          href="#main"
          className="fixed top-4 left-4 z-60 -translate-y-16 rounded-md bg-primary p-3 text-primary-foreground opacity-0 transition-[transform,opacity] focus:translate-y-0 focus:opacity-100 motion-reduce:transition-none"
        >
          Skip to content
        </a>
        <Outlet />
      </TooltipProvider>
    </NotificationsProvider>
  );
}
