// dsh-better-git-worktree — stable, human-readable names for managed worktrees.
//
// A branch called `dsh/dsh-deploy-3ba3ac8c` tells nobody anything, so each
// working copy gets a two-part pet name (`brave-otter`) chosen once, stored in
// the registry, and reused for its directory, its branch, and every surface
// that shows it.

const ADJECTIVES = [
  'amber', 'brave', 'brisk', 'calm', 'clever', 'coral', 'cosmic', 'crisp',
  'daring', 'eager', 'fleet', 'gentle', 'glad', 'golden', 'hardy', 'hazel',
  'humble', 'ivory', 'jolly', 'keen', 'lively', 'lucid', 'mellow', 'merry',
  'nimble', 'noble', 'placid', 'polar', 'proud', 'quiet', 'rapid', 'ready',
  'rustic', 'silent', 'sleek', 'solar', 'steady', 'sunny', 'swift', 'tidy',
  'vivid', 'warm', 'witty', 'zesty',
];

const NOUNS = [
  'acorn', 'alder', 'aspen', 'badger', 'beacon', 'birch', 'bison', 'brook',
  'cedar', 'cinder', 'clover', 'comet', 'crane', 'delta', 'dune', 'ember',
  'falcon', 'fern', 'finch', 'forge', 'garnet', 'glacier', 'harbor', 'heron',
  'juniper', 'kestrel', 'lantern', 'lark', 'lichen', 'lupine', 'marlin', 'meadow',
  'mesa', 'mosaic', 'otter', 'pelican', 'pine', 'quarry', 'raven', 'reef',
  'ridge', 'rowan', 'salmon', 'sedge', 'sparrow', 'summit', 'thistle', 'tundra',
  'walnut', 'willow',
];

/** One random two-part name, e.g. `brave-otter`. */
export function randomPetName(random = Math.random) {
  const adjective = ADJECTIVES[Math.floor(random() * ADJECTIVES.length) % ADJECTIVES.length];
  const noun = NOUNS[Math.floor(random() * NOUNS.length) % NOUNS.length];
  return `${adjective}-${noun}`;
}

/**
 * A pet name whose directory and branch are both free.
 * @param managedRoot - the managed-worktree base directory
 * @param branchOwner - a path whose `refs/heads/*` must not already hold the name
 */
export async function allocatePetName({ managedRoot, branchOwner, exists, hasBranch, attempts = 40 }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const name = randomPetName();
    if (exists(name)) continue;
    if (await hasBranch(name)) continue;
    return name;
  }
  // Deterministic fallback: a name plus a short suffix, so this can never spin.
  const base = randomPetName();
  for (let index = 2; index < 100; index += 1) {
    const name = `${base}-${index}`;
    if (!exists(name) && !(await hasBranch(name))) return name;
  }
  throw new Error(`could not allocate a free worktree name under ${managedRoot}`);
}
