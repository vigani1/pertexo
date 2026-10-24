import { EllipsisIcon, LockIcon, PlusIcon, UsersIcon } from 'lucide-react';
import type { WorkflowFolder } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  childFolders,
  folderTrail,
} from '../../../model/organization/folder-navigation';

type OnFolder<Kind extends string> = Readonly<{
  kind: Kind;
  folder: WorkflowFolder;
}>;
export type FolderAction =
  | Readonly<{ kind: 'create'; parent: WorkflowFolder | null }>
  | OnFolder<'rename'>
  | OnFolder<'move'>
  | OnFolder<'share'>
  | OnFolder<'delete'>;

/**
 * Folders at the current level, above the workflows in it. Inside a folder,
 * the path back out is drawn as a thread with a knot per level.
 */
export function FolderShelf({
  folders,
  currentFolderId,
  canManage,
  onOpen,
  onAction,
}: Readonly<{
  folders: readonly WorkflowFolder[];
  currentFolderId: string | undefined;
  canManage: boolean;
  onOpen: (folderId: string | null) => void;
  onAction: (action: FolderAction) => void;
}>) {
  const trail = folderTrail(folders, currentFolderId);
  const current = trail.at(-1);
  const children = childFolders(folders, current?.id ?? null);
  // Unfiled and unknown folder filters keep the list as it is.
  if (currentFolderId !== undefined && current === undefined) return null;
  if (current === undefined && children.length === 0 && !canManage) return null;
  return (
    <section aria-label="Folders" className="flex flex-col gap-3">
      {current === undefined ? null : (
        <CurrentFolder
          trail={trail}
          folder={current}
          canManage={canManage}
          onOpen={onOpen}
          onAction={onAction}
        />
      )}
      {children.length === 0 && !canManage ? null : (
        <ul className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible">
          {children.map((folder) => (
            <FolderTile
              key={folder.id}
              folder={folder}
              canManage={canManage}
              onOpen={onOpen}
              onAction={onAction}
            />
          ))}
          {canManage ? (
            <li className="shrink-0 snap-start">
              <Button
                type="button"
                variant="ghost"
                className="h-11 border border-dashed border-border-strong px-4 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  onAction({ kind: 'create', parent: current ?? null });
                }}
              >
                <PlusIcon aria-hidden="true" />
                New folder
              </Button>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

function FolderTrail({
  above,
  onOpen,
}: Readonly<{
  above: readonly WorkflowFolder[];
  onOpen: (folderId: string | null) => void;
}>) {
  const crumbs = [
    { id: null, name: 'All workflows' },
    ...above.map(({ id, name }) => ({ id, name })),
  ];
  return (
    <nav aria-label="Folder path" className="min-w-0">
      <ol className="flex min-w-0 flex-wrap items-center gap-y-1 text-sm">
        {crumbs.map((crumb, index) => (
          <li key={crumb.id ?? 'all'} className="flex min-w-0 items-center">
            {index === 0 ? null : <TrailThread current={false} />}
            <button
              type="button"
              className="truncate rounded-sm text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none"
              onClick={() => {
                onOpen(crumb.id);
              }}
            >
              {crumb.name}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** A short run of thread ending in a knot; the current level's knot is lit. */
function TrailThread({ current }: Readonly<{ current: boolean }>) {
  return (
    <span aria-hidden="true" className="mx-2 flex items-center">
      <span className="h-px w-5 bg-border-strong" />
      <span
        className={cn(
          'size-1.5 rounded-full border',
          current
            ? 'border-primary bg-primary'
            : 'border-border-strong bg-background',
        )}
      />
      <span className="h-px w-1.5 bg-border-strong" />
    </span>
  );
}

/** The way back out, this folder's name and who can open it, on one line. */
function CurrentFolder({
  trail,
  folder,
  canManage,
  onOpen,
  onAction,
}: Readonly<{
  trail: readonly WorkflowFolder[];
  folder: WorkflowFolder;
  canManage: boolean;
  onOpen: (folderId: string | null) => void;
  onAction: (action: FolderAction) => void;
}>) {
  const restricted = folder.accessMode === 'restricted';
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="flex min-w-0 items-center">
        <FolderTrail above={trail.slice(0, -1)} onOpen={onOpen} />
        <TrailThread current />
        <h2 className="min-w-0 font-display text-xl leading-tight wrap-anywhere [--display-optical-size:24]">
          {folder.name}
        </h2>
      </span>
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        {restricted ? (
          <LockIcon aria-hidden="true" className="size-3" />
        ) : (
          <UsersIcon aria-hidden="true" className="size-3" />
        )}
        {restricted ? 'Only chosen people' : 'Everyone in the workspace'}
      </span>
      {canManage ? (
        <span className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              onAction({ kind: 'share', folder });
            }}
          >
            Share
          </Button>
          <FolderMenu folder={folder} onAction={onAction} />
        </span>
      ) : null}
    </div>
  );
}

function FolderTile({
  folder,
  canManage,
  onOpen,
  onAction,
}: Readonly<{
  folder: WorkflowFolder;
  canManage: boolean;
  onOpen: (folderId: string) => void;
  onAction: (action: FolderAction) => void;
}>) {
  const restricted = folder.accessMode === 'restricted';
  return (
    <li className="group relative flex h-11 max-w-64 min-w-44 shrink-0 snap-start items-center gap-1 rounded-lg border border-border bg-card/60 pr-1 pl-3 transition-colors hover:border-border-strong motion-reduce:transition-none">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left after:absolute after:inset-0 after:rounded-lg"
        onClick={() => {
          onOpen(folder.id);
        }}
      >
        <SkeinGlyph />
        <span className="truncate text-sm font-medium">{folder.name}</span>
        {restricted ? (
          <LockIcon
            role="img"
            aria-label="Only chosen people"
            className="size-3 shrink-0 text-muted-foreground"
          />
        ) : null}
      </button>
      {canManage ? (
        <span className="relative z-10">
          <FolderMenu folder={folder} onAction={onAction} />
        </span>
      ) : null}
    </li>
  );
}

/** Three threads gathered into one knot: a folder of workflows. */
function SkeinGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 22 14"
      className="h-3.5 w-5.5 shrink-0 text-border-strong"
    >
      <path
        d="M1 2.5 C8 2.5 11 7 16 7 M1 7 H16 M1 11.5 C8 11.5 11 7 16 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="17.5" cy="7" r="2.4" className="fill-primary" />
    </svg>
  );
}

function FolderMenu({
  folder,
  onAction,
}: Readonly<{
  folder: WorkflowFolder;
  onAction: (action: FolderAction) => void;
}>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${folder.name}`}
          />
        }
      >
        <EllipsisIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {(['rename', 'move', 'share'] as const).map((kind) => (
          <DropdownMenuItem
            key={kind}
            onClick={() => {
              onAction({ kind, folder });
            }}
          >
            {FOLDER_ACTION_LABEL[kind]}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => {
            onAction({ kind: 'delete', folder });
          }}
        >
          Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const FOLDER_ACTION_LABEL = {
  rename: 'Rename…',
  move: 'Move to…',
  share: 'Share…',
} as const;
