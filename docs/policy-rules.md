# CHATS-Sandbox Policy Rule Generation Prompt

Use this document as the system prompt when asking an LLM (Claude, GPT,
etc.) to generate additional tier-0 policy rules for CHATS-Sandbox. The
LLM should produce a valid TypeScript module that conforms to the rule
schema defined here, covering the categories you ask for.

Paste this entire document into the model, then append a short request
like: *"Add rules for `git reset --hard`, `docker rm`, and `kubectl
delete pod/...`. Output a single TypeScript module, no commentary."*

---

## What CHATS-Sandbox is

A Claude Code plugin that backs up state before any potentially
destructive tool call. Four tiers run in priority order:

- **Tier 0 (policy rewrite)** — *this is what these rules are.* A rule
  intercepts a destructive command and rewrites it into a reversible
  equivalent. Example: `rm -rf foo` becomes `mv foo
  .chats-sandbox/backups/action_NNN/trash/foo`. On restore, the recorded
  recovery command reverses the rewrite. Advantage: O(1) inode rename
  instead of O(N) file copy; works for arbitrary data sizes.

- Tier 1 (targeted manifest): `pip freeze`, `npm list`, `env` snapshot, git tag.
- Tier 2 (git shadow repo): `git add -A` snapshot of the workspace.
- Tier 3 (subagent): a `claude -p` child call reasons about out-of-workspace or dynamic state.

Tier 0 is the cheapest and most deterministic of the four. We want rich
coverage so common destructive ops never escalate into tiers 2/3.

## The core principle

Tier-0 is **delete-centric**. Not every tool call needs a rule — in fact
most don't. Think of ops in three buckets:

| Op type | Destroys data? | Where it belongs | What a rule does (if any) |
|---------|---------------|------------------|----------------------------|
| **Add** — `touch`, `mkdir`, Write-new-file, `cp a b` (b new), `mv a b` (b new) | No | Tier-0 *only* when you want to track the inverse. No data to preserve. | Record `rm <created-path>` as `recoveryCommands`. Empty `trash/`. |
| **Update** — Edit, `mv` overwrite, `chmod`, `chown`, `git reset --hard`, SQL UPDATE | Yes (old state) | **Tier-2 (git_snapshot)** for inside-workspace; **Tier-3 (subagent)** for outside. | Usually nothing — git's delta storage already handles pre-state efficiently. Don't write an update rule unless there's a specific reason. |
| **Delete** — `rm`, `DROP TABLE`, `docker rm`, `kubectl delete`, `git branch -D` | Yes (whole thing) | **Tier-0 policy rewrite** | Move/snapshot the pre-state (usually via inode rename), record the inverse. |

**Why tier-0 wins for deletes specifically:** the cost asymmetry is
decisive. `mv` is O(1); `cp` / `git add -A` of a large tree is O(N).
For a 10 GB `rm -rf data/`, tier-2 would try to copy the whole thing
into the shadow repo — minutes of I/O, lots of disk. Tier-0 renames the
inode and is instant. Same argument applies to `docker volume rm`
(volumes are large), `kubectl delete pod` (manifest snapshot is tiny
vs reasoning about desired state), etc.

**Why tier-0 doesn't buy much for updates:** the pre-state is already
preserved cheaply by tier-2's git shadow repo. Git's object store
handles deltas well; there's no "rename instead of copy" trick
available for an in-place modification. Writing an update rule would
be strictly more work for equivalent or worse result.

**Special case — creates outside the workspace:** a `Write` to a path
outside cwd currently escalates to tier-3 (a real `claude -p` call,
~10-30s, token cost). But there's nothing to *preserve* — the path
didn't exist before. A tier-0 rule that just records `rm <path>` as
the recovery command is much cheaper. This is the one create-like case
where tier-0 adds real value.

### Precheck discipline

- `mv a b` or `cp a b` where `b` doesn't exist: *do not rewrite*. The
  op is benign. Your `apply` must `stat` the target and return `null`.
- `rm foo` where `foo` doesn't exist: `rm` would error anyway; return
  `null` and let it error.
- `chmod` / `chown`: the "data" being destroyed is just the old mode.
  Your rule should save the output of `stat --format=%a` (or `%u:%g`)
  into the artifact, NOT move the file anywhere.

## The rule schema

```typescript
import type { HookContext } from "../types.js";

export interface PolicyRuleResult {
  /** Tool input the hook should return as `updatedInput`. Claude Code
   *  re-invokes the tool with this; the original command is replaced. */
  updatedInput: Record<string, unknown>;
  /** Commands the plugin ran BEFORE returning (e.g. the mv-to-trash).
   *  Recorded on the artifact for audit. */
  preCommands: string[];
  /** Commands that reverse the whole effect. Run via execSync on
   *  `chats-sandbox restore`. No LLM reasoning at restore time. */
  recoveryCommands: string[];
  /** Short human summary for the action card. */
  description: string;
  /** Stable rule id matching `PolicyRule.id`. */
  ruleId: string;
}

export interface PolicyRule {
  id: string;
  category: "fs-delete" | "fs-overwrite" | "git" | "container" | "k8s" | "db";
  /** Tool this rule applies to. Most rules target Bash. */
  toolName: "Bash" | "Write" | "Edit";
  /** Regex over the raw command (for Bash) or over JSON.stringify(tool_input). */
  pattern: RegExp;
  /** Safety exclusion. If this matches, the rule does NOT fire. */
  exclude?: RegExp;
  confidence: "high" | "medium" | "low";
  description: string;
  /** Returns null when the rule matched pattern but decided not to apply
   *  (e.g. target doesn't exist, cross-filesystem, compound command). */
  apply(
    match: RegExpMatchArray,
    ctx: HookContext,
    trashDir: string,
  ): PolicyRuleResult | null;
}
```

## Reference implementation: the `rm` rule

Live in `src/backup/policy_rules.ts`. Abbreviated:

```typescript
{
  id: "rm-to-trash",
  category: "fs-delete",
  toolName: "Bash",
  pattern: /^\s*rm\s+/,
  exclude: /\brm\s+(?:-[a-zA-Z]+\s+)*(?:\/|~|\.|\.\.|\*)\s*(?:$|[|;&])/,
  confidence: "high",
  description: "Rewrite rm into mv to a per-action trash.",
  apply(_match, ctx, trashDir) {
    const command = String(ctx.tool_input.command ?? "");
    const parsed = parseRmArgs(command);
    if (!parsed || parsed.paths.length === 0) return null;
    // bail on any dangerous path, any missing file, cross-fs moves
    // ... (see full source)
    // build preCommands + recoveryCommands, run mv, return result
  },
}
```

Read the full file for:
- how `parseRmArgs` rejects compound/substitution/glob commands,
- the `DANGEROUS_PATHS` set,
- cross-device (cross-filesystem) detection via `stat.dev`,
- how recovery commands are built in LIFO order so restore unwinds correctly.

## Hard constraints for every new rule

1. **Refuse to rewrite catastrophic targets.** `rm -rf /`, `rm -rf ~`,
   `rm -rf .`, `DROP DATABASE`, `kubectl delete namespace default`, etc.
   Exclude them via the `exclude` regex, or detect and return `null`
   from `apply`.
2. **Never rewrite compound commands.** If the command contains `|`,
   `&`, `;`, backticks, `$(...)`, reject (return `null`). The rule layer
   cannot safely modify only part of a pipeline.
3. **Never rewrite glob expressions.** `rm *.log`, `find … -delete`,
   `xargs rm` — the expansion happens at shell time and we can't see
   the final file list. Return `null`, let tier-2/3 handle.
4. **Cross-filesystem operations must fall through.** Tier-0's speed
   comes from O(1) inode rename. If the source and target of the mv
   would be on different devices (`stat -c %d` differs), `mv` becomes
   a full copy and the rule gains nothing. Detect and return `null`.
5. **Never return `updatedInput` that runs arbitrary commands with the
   user's original args.** The rewrite must be a KNOWN reversible form,
   not a shell one-liner you invented. `updatedInput.command` should be
   `true` (a noop) or the precise safe-variant you crafted.
6. **recoveryCommands must be exact inverses.** If `preCommands` moved
   3 files, `recoveryCommands` must move all 3 back, in reverse order.
   `restore` executes them verbatim with `execSync` — no retries, no
   planning.
7. **Every `apply` must be idempotent on failure.** If `preCommands`
   runs partway and the next command fails, the rule must `return
   null` *after* undoing any already-completed moves. A half-applied
   rule is worse than no rule.
8. **Trash lives in the action folder.** Never write to a separate
   long-lived location. The action folder's retention sweep is what
   makes soft-delete eventually become hard-delete — don't bypass it.

## Categories worth targeting

Ranked by impact × ease:

### High impact, high confidence
- `git reset --hard <ref>` — record HEAD sha before, recovery is `git reset --hard <old-sha>`.
- `git branch -D <name>` — tag the sha first, recovery recreates the branch.
- `git stash drop` — pre-save the stash to a ref before running.
- `git push --force[ | --force-with-lease] <remote> <ref>` — record
  remote ref sha via `git ls-remote` first; recovery force-pushes the
  old sha back. Mark `liveRestore: true` because the remote may have
  moved again by the time restore runs.
- `docker rm <container>` — `docker commit <id> chats-recovery-<id>`
  first; recovery runs the committed image with the original name.
  Preserves the filesystem; does NOT preserve running state.
- `docker volume rm <vol>` — `docker run --rm -v <vol>:/v busybox tar c
  /v > $TRASH/<vol>.tar` first; recovery creates a new volume and
  restores the tar.
- `docker image rm <ref>` — `docker save <ref> > $TRASH/<ref>.tar`
  first; recovery `docker load -i`.
- `kubectl delete <kind>/<name>` — `kubectl get <kind>/<name> -o yaml >
  $TRASH/<name>.yml` first; recovery `kubectl apply -f` that file.
  Works for most namespaced resources; skip for cluster-wide deletes of
  critical resources (namespaces, CRDs).

### Medium impact
- `chmod <mode> <path>` — save `stat --format=%a <path>` before;
  recovery runs `chmod <old-mode> <path>`.
- `chown <spec> <path>` — save `stat --format=%u:%g`; recovery `chown <old>`.
- `truncate --size=0 <file>` — mv to trash first, then let truncate run.
- `ln -sf <src> <dst>` where dst exists — mv dst to trash first.
- `gcloud ... delete` / `aws ... delete` — best-effort describe-to-yaml
  and save; mark `liveRestore: true`.

### Lower impact / higher complexity
- SQL `DROP TABLE <t>` — depends on DB client. For `psql` / `mysql`:
  rewrite to `ALTER TABLE <t> RENAME TO _chats_trash_<t>_<ts>`, preserve
  data. Recovery renames back. Mark `confidence: "medium"` — works only
  when the connection string is passed in a standard flag form you can
  parse.
- `DELETE FROM <t> WHERE <pred>` — far harder; usually requires
  snapshotting matched rows via `CREATE TABLE _undo AS SELECT ... WHERE
  <pred>` before the delete. Rarely worth a dedicated rule.
- `systemctl stop <svc>` / `launchctl unload` — not really destructive
  (state is re-enterable by starting), but can lose runtime state.
  Probably skip.

## Your task

Given the categories listed by the user (or "all high-impact categories"
if none listed), generate a single TypeScript module:

- File: `src/backup/policy_rules_extra.ts` (or a name the user asks for).
- Exports a `const EXTRA_RULES: PolicyRule[]` that includes every new
  rule you wrote.
- Each rule's `apply` function must be fully implemented — no TODOs, no
  placeholders. If you can't fully implement a rule safely, omit it.
- Include `trashName`, `shq`, and any helpers you need, or import them
  from `./policy_rules.js`.
- At the top of the file, list the rules in a comment block with id,
  category, confidence, and a one-line description. This is what a
  maintainer scans first.

Do NOT output markdown fences, narrative, or explanation around the
code. One TS file, nothing else.

After generating, the user will paste your output into the repo,
run `npm run lint && npm run build && npm test`, and validate
behavior via `tests-e2e/` scenarios. Rules that fail lint or break
tests will be deleted without review — aim for strict TypeScript,
no `any`, no unused params.
