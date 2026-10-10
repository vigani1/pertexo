import { and, asc, eq, gt, notInArray, notExists, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import {
  workspaceInvitationAcceptanceIntents as intents,
  workspaceInvitationBindingReplacementClaims as claims,
} from '../schema/foundation.js';

type Claim = typeof claims.$inferSelect;
type Binding = Readonly<{
  workspaceId: string;
  intentId: string;
  bindingDigest: string;
}>;
const MAXIMUM_LINEAGE_DEPTH = 32;
const QUERY_PAGE_SIZE = 1_000;

const prior = (claim: Claim): Binding => ({
  workspaceId: claim.priorWorkspaceId,
  intentId: claim.priorIntentId,
  bindingDigest: claim.priorBindingDigest,
});
const successor = (claim: Claim): Binding => ({
  workspaceId: claim.successorWorkspaceId,
  intentId: claim.successorIntentId,
  bindingDigest: claim.successorBindingDigest,
});
const key = (binding: Binding): string =>
  `${binding.workspaceId}:${binding.intentId}:${binding.bindingDigest}`;
const matchesClaim = (binding: Binding) =>
  and(
    eq(claims.priorWorkspaceId, binding.workspaceId),
    eq(claims.priorIntentId, binding.intentId),
    eq(claims.priorBindingDigest, binding.bindingDigest),
  );
const matchesIntent = (binding: Binding) =>
  and(
    eq(intents.workspaceId, binding.workspaceId),
    eq(intents.id, binding.intentId),
    eq(intents.bindingDigest, binding.bindingDigest),
  );

/** Reads a frontier for every candidate together, including a depth-limit tail. */
async function readLineages(
  client: PoolClient,
  roots: readonly Claim[],
): Promise<ReadonlyMap<string, Claim>> {
  const db = drizzle(client);
  const rows = new Map<string, Claim>();
  const requested = new Set<string>();
  let frontier = roots.map(prior);
  for (
    let depth = 0;
    depth <= MAXIMUM_LINEAGE_DEPTH && frontier.length > 0;
    depth++
  ) {
    const wanted = frontier.filter((binding) => {
      const identity = key(binding);
      if (requested.has(identity)) return false;
      requested.add(identity);
      return true;
    });
    frontier = [];
    for (let offset = 0; offset < wanted.length; offset += QUERY_PAGE_SIZE) {
      const page = await db
        .select()
        .from(claims)
        .where(
          or(
            ...wanted.slice(offset, offset + QUERY_PAGE_SIZE).map(matchesClaim),
          ),
        );
      for (const claim of page) {
        rows.set(key(prior(claim)), claim);
        frontier.push(successor(claim));
      }
    }
  }
  return rows;
}

function lineage(root: Claim, rows: ReadonlyMap<string, Claim>) {
  const visited = new Set<string>();
  const chain: Claim[] = [];
  let current: Claim | undefined = rows.get(key(prior(root)));
  while (current !== undefined) {
    const identity = key(prior(current));
    if (visited.has(identity) || chain.length === MAXIMUM_LINEAGE_DEPTH)
      return { chain, unsafe: true };
    visited.add(identity);
    chain.push(current);
    current = rows.get(key(successor(current)));
  }
  return { chain, unsafe: chain.length === 0 };
}

async function liveSuccessors(
  client: PoolClient,
  rows: ReadonlyMap<string, Claim>,
): Promise<ReadonlySet<string>> {
  const db = drizzle(client);
  const bindings = [
    ...new Map(
      [...rows.values()].map((claim) => {
        const binding = successor(claim);
        return [key(binding), binding] as const;
      }),
    ).values(),
  ];
  const live = new Set<string>();
  for (let offset = 0; offset < bindings.length; offset += QUERY_PAGE_SIZE) {
    const page = await db
      .select({
        workspaceId: intents.workspaceId,
        intentId: intents.id,
        bindingDigest: intents.bindingDigest,
      })
      .from(intents)
      .where(
        and(
          or(
            ...bindings
              .slice(offset, offset + QUERY_PAGE_SIZE)
              .map(matchesIntent),
          ),
          notInArray(intents.status, ['abandoned', 'superseded']),
          gt(intents.expiresAt, sql`clock_timestamp()`),
        ),
      );
    for (const binding of page) live.add(key(binding));
  }
  return live;
}

/** Retention and workspace purge share the same binding locks and safety check. */
export async function reapInvitationReplacementClaims(
  client: PoolClient,
  pageSize: number,
  workspaceId?: string,
): Promise<number> {
  const db = drizzle(client);
  const directSuccessorLive = db
    .select({ id: intents.id })
    .from(intents)
    .where(
      and(
        eq(intents.workspaceId, claims.successorWorkspaceId),
        eq(intents.id, claims.successorIntentId),
        eq(intents.bindingDigest, claims.successorBindingDigest),
        notInArray(intents.status, ['abandoned', 'superseded']),
        gt(intents.expiresAt, sql`clock_timestamp()`),
      ),
    );
  let removed = 0;
  let cursor: Binding | undefined;
  // Seek past unsafe candidates, as the old SQL filtered them before LIMIT.
  while (removed < pageSize) {
    const candidates = await db
      .select()
      .from(claims)
      .where(
        and(
          workspaceId === undefined
            ? undefined
            : or(
                eq(claims.priorWorkspaceId, workspaceId),
                eq(claims.successorWorkspaceId, workspaceId),
              ),
          notExists(directSuccessorLive),
          cursor === undefined
            ? undefined
            : sql`(${claims.priorWorkspaceId}, ${claims.priorIntentId}, ${claims.priorBindingDigest}) > (${cursor.workspaceId}::uuid, ${cursor.intentId}::uuid, ${cursor.bindingDigest}::char(64))`,
        ),
      )
      .orderBy(
        asc(claims.priorWorkspaceId),
        asc(claims.priorIntentId),
        asc(claims.priorBindingDigest),
      )
      .limit(pageSize - removed);
    const last = candidates.at(-1);
    if (last === undefined) break;
    cursor = prior(last);
    const before = await readLineages(client, candidates);
    const digests = [
      ...new Set(
        candidates.flatMap((root) =>
          lineage(root, before).chain.flatMap((claim) => [
            claim.priorBindingDigest,
            claim.successorBindingDigest,
          ]),
        ),
      ),
    ].sort();
    if (digests.length === 0) continue;
    await client.query(
      'select pg_advisory_xact_lock(hashtextextended(binding_digest,0)) from unnest($1::text[]) binding_digest order by binding_digest',
      [digests],
    );
    // Re-read after locking: a live replacement may have won the lock first.
    const after = await readLineages(client, candidates);
    const live = await liveSuccessors(client, after);
    const safe = candidates.filter((root) => {
      const { chain, unsafe } = lineage(root, after);
      return (
        !unsafe && chain.every((claim) => !live.has(key(successor(claim))))
      );
    });
    if (safe.length > 0)
      removed += (
        await db
          .delete(claims)
          .where(or(...safe.map((claim) => matchesClaim(prior(claim)))))
          .returning({ id: claims.priorIntentId })
      ).length;
  }
  return removed;
}
