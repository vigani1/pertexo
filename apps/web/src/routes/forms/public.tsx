import { useRouteContext } from '@tanstack/react-router';
import { FormPage } from '@/features/forms/pages.public';
import { Notice } from '@/components/ui/notice';
export function PublicFormRoute() {
  const { publicForm } = useRouteContext({ from: '/forms/$publicId' });
  return (
    <main className="min-h-dvh bg-background px-5 py-10 text-foreground sm:px-8 sm:py-16">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
        <p className="font-heading text-lg font-semibold text-muted-foreground">
          Pertexo
        </p>
        {publicForm === null ? (
          <Notice tone="warning">
            This form link is incomplete or invalid. Ask its owner for a current
            link.
          </Notice>
        ) : (
          <FormPage scope={publicForm} />
        )}
      </div>
    </main>
  );
}
