/** A workspace whose inbox changed, with its newest thread revision. */
export type WorkspaceInboxChange = Readonly<{
  workspaceId: string;
  revision: string;
}>;
