/** 0: waiting for input · 1: running · 2: open in a terminal but idle · 3: everything else */
export type SortGroup = 0 | 1 | 2 | 3;

export interface Sortable {
  key: string;
  group: SortGroup;
  mtimeMs: number;
}

/** Remembers when each session entered its group. */
export type GroupMemo = Map<string, { group: SortGroup; since: number }>;

/**
 * Orders by group; inside groups 0-2 the session that most recently entered the group comes first,
 * so the order only changes on a state change rather than on every write. Group 3 is newest first.
 * A session seen for the first time is dated by its last activity, so the first render is by recency.
 */
export function sortByState<T extends Sortable>(items: T[], memo: GroupMemo, now: number): T[] {
  const keyed = items.map(item => {
    const prev = memo.get(item.key);
    let entry = prev;
    if (!prev || prev.group !== item.group) {
      entry = { group: item.group, since: prev ? now : item.mtimeMs };
      memo.set(item.key, entry);
    }
    return { item, since: entry!.since };
  });
  keyed.sort((a, b) => a.item.group - b.item.group || (a.item.group < 3 ? b.since - a.since : b.item.mtimeMs - a.item.mtimeMs));
  return keyed.map(k => k.item);
}

/** Drops memo entries for sessions that are gone. */
export function pruneMemo(memo: GroupMemo, alive: Set<string>): void {
  for (const k of memo.keys()) if (!alive.has(k)) memo.delete(k);
}
