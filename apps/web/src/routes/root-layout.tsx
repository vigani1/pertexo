import { HeadContent, Outlet } from '@tanstack/react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import { NavigationProgress } from './navigation-progress';

export function RootLayout() {
  // Notifications sit above the router (main.tsx), so they outlive a crash.
  return (
    <TooltipProvider delay={400}>
      <HeadContent />
      <NavigationProgress />
      <a
        href="#main"
        className="fixed top-4 left-4 z-60 -translate-y-16 rounded-md bg-action p-3 text-action-foreground opacity-0 transition-[transform,opacity] focus:translate-y-0 focus:opacity-100 motion-reduce:transition-none"
      >
        Skip to content
      </a>
      <Outlet />
    </TooltipProvider>
  );
}
