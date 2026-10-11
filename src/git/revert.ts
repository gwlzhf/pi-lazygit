import type { RevertPlan } from "../contracts";
import { PATH_BATCH_SIZE } from "./commit";

export interface RevertInvocation {
  readonly argv: readonly string[];
}

function batched(paths: readonly string[]): readonly (readonly string[])[] {
  const batches: string[][] = [];
  for (let index = 0; index < paths.length; index += PATH_BATCH_SIZE) {
    batches.push(paths.slice(index, index + PATH_BATCH_SIZE));
  }
  return batches;
}

export interface RevertArgvOptions {
  /** Without a commit to restore from, an addition is removed outright. */
  readonly hasHead: boolean;
}

/**
 * The commands that carry out `plan`, in the order they have to run.
 *
 * `git clean` only ever sees untracked paths: `-x` is never passed, so an
 * ignored file stays on disk even when Git reports it among the changes.
 */
export function revertInvocations(
  plan: RevertPlan,
  options: RevertArgvOptions,
): readonly RevertInvocation[] {
  const invocations: RevertInvocation[] = [];
  const add = (argv: string[], batch: readonly string[]): void => {
    invocations.push({ argv: Object.freeze([...argv, "--", ...batch]) });
  };

  if (options.hasHead) {
    for (const batch of batched(plan.restore)) {
      add(["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree"], batch);
    }
    for (const batch of batched(plan.unindex)) {
      add(["--literal-pathspecs", "restore", "--staged"], batch);
    }
  } else {
    // An unborn HEAD has nothing to restore to, so every tracked path in the
    // selection is an addition that only has to be taken back out.
    for (const batch of batched([...plan.restore, ...plan.unindex])) {
      add(["--literal-pathspecs", "rm", "-q", "-f"], batch);
    }
  }
  for (const batch of batched(plan.remove)) {
    add(["--literal-pathspecs", "clean", "-q", "-f"], batch);
  }
  return Object.freeze(invocations);
}