import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { publicFormParamsSchema } from '@pertexo/contracts';
import { publicFormScope } from '@/features/forms/queries.public';
import { rootRoute } from '../root/route';
export const publicFormRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'forms/$publicId',
  head: () => ({
    meta: [
      { title: 'Form — Pertexo' },
      { name: 'referrer', content: 'no-referrer' },
    ],
  }),
  beforeLoad: async ({ context, params, location }) => {
    const parsed = publicFormParamsSchema.safeParse(params);
    return {
      publicForm: parsed.success
        ? await publicFormScope(
            context.apiClient,
            parsed.data.publicId,
            location.hash,
          )
        : null,
    };
  },
  component: lazyRouteComponent(() => import('./public'), 'PublicFormRoute'),
});
