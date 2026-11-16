import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  listSourceFiles,
  listWorkspaces,
  report,
  repositoryRoot,
} from './workspace-sources.mjs';

export const CROWDED_FOLDERS = Object.freeze({
  'apps/web/src/components/ui':
    'Catalog of named UI primitives; a flat inventory is its interface.',
  'apps/web/src/routes/workspace':
    'Peer workspace routes grouped by router scope.',
  'apps/api/src/platform/http':
    'The HTTP adapter boundary: request decoding, response projection and framework composition are read together.',
  'packages/workflow-engine/src/compilation':
    'One graph-to-executable compilation pipeline; validation and capacity share its representation.',
  'packages/core/src/identity/federation/management':
    'Peer federation-management operations and their persistence, behind one management facade.',
  'packages/core/src/runs/commands/acceptance':
    'One run-admission transaction; its locks, checkpoint and receipt share the acceptance protocol.',
  'packages/core/src/lifecycle/retention/rules':
    'Catalog of retention rules by stored subject.',
  'packages/core/src/authoring/promotion':
    'One promotion flow with preview, apply and provenance behind its facade.',
  'packages/core/src/authoring/collaboration':
    'One collaboration facade for comments, mentions and presence sharing workflow authority.',
  'packages/core/src/previews/attempts':
    'One preview-attempt lease lifecycle from claim through completion and expiry.',
});

export const DEEP_FOLDERS = Object.freeze({
  'apps/web/src/features/workflow-editor/components/inspector':
    'Inspector panels and their matching model concepts retain predictable subject folders.',
  'apps/web/src/features/workflow-editor/components/canvas':
    'Canvas cards and notes have separate rendering and interaction responsibilities.',
  'apps/web/src/features/workflow-editor/model/inspector':
    'Inspector panels and their matching model concepts retain predictable subject folders.',
  'apps/web/src/features/auth/components/account/profile':
    'Profile identity and display-name editing belong together within account settings.',
  'apps/web/src/features/workflows/components/organization/tags':
    'Tag creation and assignment are a coherent organization control.',
  'apps/web/src/features/workflows/components/organization/folders':
    'Folder selection, creation and sharing are a coherent organization control.',
  'apps/web/src/features/workflows/components/list/commands':
    'List command controls share selection and pending-action presentation.',
  'apps/web/src/features/workflow-runs/components/run-detail/data':
    'Run-detail data inspectors stay separate from timeline presentation.',
  'apps/web/src/features/workflow-runs/components/run-detail/timeline':
    'Run timeline entries and their status presentation form one subject.',
  'apps/web/src/features/federation/components/providers/fields':
    'Provider-specific configuration fields share the provider editor boundary.',
  'apps/web/src/features/workflow-settings/components/triggers/schedules':
    'Schedule editing and its controls form one trigger subject.',
  'apps/web/src/features/workflow-settings/components/triggers/webhooks':
    'Webhook endpoint, delivery and reply controls form one trigger subject.',
});

export function validateFolderLayout(
  files,
  crowded = CROWDED_FOLDERS,
  deep = DEEP_FOLDERS,
) {
  const counts = new Map();
  const deepFolders = new Set();
  const findings = [];
  for (const file of files) {
    const folder = path.posix.dirname(file);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
    const relative = folder.split('/src/')[1];
    if (relative !== undefined && relative.split('/').length > 4)
      deepFolders.add(folder);
  }
  for (const [folder, count] of counts)
    if (count > 15 && !Object.hasOwn(crowded, folder))
      findings.push(
        `${folder}: ${count} direct code files; split by responsibility or list in CROWDED_FOLDERS with a reason.`,
      );
  for (const folder of deepFolders)
    if (
      !Object.keys(deep).some(
        (entry) => folder === entry || folder.startsWith(`${entry}/`),
      )
    )
      findings.push(
        `${folder}: more than four directories below src; flatten or list in DEEP_FOLDERS with a reason.`,
      );
  for (const [folder, reason] of Object.entries(crowded))
    if (!reason.trim() || (counts.get(folder) ?? 0) <= 15)
      findings.push(
        `${folder}: stale CROWDED_FOLDERS entry or missing reason.`,
      );
  for (const [folder, reason] of Object.entries(deep))
    if (
      !reason.trim() ||
      ![...deepFolders].some(
        (entry) => entry === folder || entry.startsWith(`${folder}/`),
      )
    )
      findings.push(`${folder}: stale DEEP_FOLDERS entry or missing reason.`);
  return findings;
}

export async function inspectFolderLayout(root = repositoryRoot) {
  const files = [];
  for (const workspace of await listWorkspaces(root))
    files.push(...(await listSourceFiles(workspace, root)));
  return validateFolderLayout(files);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  report(
    await inspectFolderLayout(),
    'Source folders follow the reviewed layout.',
  );
