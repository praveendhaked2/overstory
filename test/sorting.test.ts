import assert from "node:assert/strict";
import { test } from "node:test";
import { sortByState, type GroupMemo, type Sortable } from "../src/core/sorting.ts";

const keys = (xs: Sortable[]) => xs.map(x => x.key).join(",");

test("groups first: waiting, running, open, rest; rest newest first", () => {
  const memo: GroupMemo = new Map();
  const items: Sortable[] = [
    { key: "old", group: 3, mtimeMs: 100 },
    { key: "new", group: 3, mtimeMs: 900 },
    { key: "open", group: 2, mtimeMs: 50 },
    { key: "run", group: 1, mtimeMs: 10 },
    { key: "wait", group: 0, mtimeMs: 5 },
  ];
  assert.equal(keys(sortByState(items, memo, 1000)), "wait,run,open,new,old");
});

test("file writes inside a group don't reorder; a state change moves the session to the top of its new group", () => {
  const memo: GroupMemo = new Map();
  let a: Sortable = { key: "a", group: 1, mtimeMs: 200 };
  let b: Sortable = { key: "b", group: 1, mtimeMs: 100 };
  assert.equal(keys(sortByState([a, b], memo, 1000)), "a,b");
  b = { ...b, mtimeMs: 5000 }; // b keeps writing
  assert.equal(keys(sortByState([a, b], memo, 5000)), "a,b", "still the same order");
  const c = { key: "c", group: 3 as const, mtimeMs: 50 };
  sortByState([a, b, c], memo, 5000);
  const c2 = { ...c, group: 1 as const }; // c starts running
  assert.equal(keys(sortByState([a, b, c2], memo, 6000)), "c,a,b");
  a = { ...a, group: 0 }; // a now needs input
  assert.equal(keys(sortByState([a, b, c2], memo, 7000)), "a,c,b");
});

import { autoBranchName } from "../src/core/names.ts";

test("automatic worktree names are readable, prefixed and avoid taken names", () => {
  const name = autoBranchName(new Set());
  assert.match(name, /^[a-z]+-[a-z]+$/);
  assert.match(autoBranchName(new Set(), "wt/"), /^wt\/[a-z]+-[a-z]+$/);
  const fixed = () => 0; // always picks "amber-badger"
  assert.equal(autoBranchName(new Set(), "", fixed), "amber-badger");
  assert.equal(autoBranchName(new Set(["amber-badger"]), "", fixed), "amber-badger-2");
});
