import {
  parseWorkflowGraphDraft,
  portableGraphDigest,
} from '@pertexo/workflow-model';

interface GraphRead {
  graph: unknown;
  graphDigest?: string | undefined;
}

/** HTTP read projections are opt-in; write/default replies retain their old shape. */
export async function workflowGraphReadBody<Body extends GraphRead>(
  url: string,
  body: Body,
) {
  const { graphDigest: _previousDigest, ...base } = body;
  const include = new URL(url).searchParams.get('include')?.split(',') ?? [];
  return include.includes('graphDigest')
    ? {
        ...base,
        graphDigest: await portableGraphDigest(
          parseWorkflowGraphDraft(body.graph),
        ),
      }
    : base;
}

export async function workflowVersionsBody<
  Body extends { items: readonly GraphRead[] },
>(url: string, body: Body) {
  return {
    ...body,
    items: await Promise.all(
      body.items.map((item) => workflowGraphReadBody(url, item)),
    ),
  };
}
