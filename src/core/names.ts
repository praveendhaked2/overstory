const ADJECTIVES = ["amber", "brisk", "calm", "clever", "cosmic", "crisp", "dusty", "eager", "fuzzy", "gentle", "golden", "hazel", "jolly", "keen", "lucky", "mellow", "misty", "nimble", "olive", "plucky", "quiet", "rapid", "rustic", "sandy", "silver", "snowy", "sunny", "swift", "tidy", "velvet", "witty", "zesty"];
const NOUNS = ["badger", "breeze", "canyon", "cedar", "comet", "coral", "delta", "ember", "falcon", "fern", "harbor", "heron", "inlet", "juniper", "lagoon", "lantern", "maple", "meadow", "otter", "pebble", "pecan", "pine", "quartz", "raven", "ridge", "river", "sparrow", "summit", "thistle", "tundra", "willow", "wren"];

/**
 * A short readable branch name like "brisk-otter" (with an optional prefix such as "wt/"),
 * avoiding every name in `taken`. Falls back to a numeric suffix if the word space runs out.
 */
export function autoBranchName(taken: Set<string>, prefix = "", rnd: () => number = Math.random): string {
  const pick = (xs: string[]) => xs[Math.floor(rnd() * xs.length) % xs.length];
  for (let i = 0; i < 50; i++) {
    const name = `${prefix}${pick(ADJECTIVES)}-${pick(NOUNS)}`;
    if (!taken.has(name)) return name;
  }
  const base = `${prefix}${pick(ADJECTIVES)}-${pick(NOUNS)}`;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}
