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

## Scope: tier-0 is for LOCAL destructive ops only

**Remote state belongs to tier-3 (the subagent), not tier-0.** Don't write
tier-0 rules for anything whose effect propagates beyond the local
machine and whose recovery requires reasoning about current (possibly
drifted) remote state. Specifically, skip:

- Cloud CLIs: `aws`, `gcloud`, `az`, `doctl`, `oci`, `linode-cli`
- REST DELETEs: `curl -X DELETE`, `httpie DELETE`, `gh` write ops to github.com
- IaC that applies to external infra: `terraform apply/destroy`, `pulumi destroy`
- Production DB clients talking over the network to hosted DBs (psql/mysql targeting a remote host — hard to even detect locally)
- Anything under **production Kubernetes clusters** beyond the single-resource case already covered (no cluster-wide sweeps, no `kubectl delete namespace`, etc.)
- Push-style operations that notify remote services: `git push --force` to a shared remote, `docker push` to a registry, `helm push`, `aws s3 sync --delete` to a bucket

Tier-0 wins because `mv` is O(1) and local. Remote ops don't have that
property: "save state locally, restore remotely" introduces a
reconciliation problem the subagent is better suited to handle at
restore time (it can read live remote state, compare, and choose the
right repair). A canned command from a pre-recorded artifact is often
stale by the time restore runs.

**Rules of thumb for deciding if an op is in-scope:**

- **In scope** — it runs entirely against the local kernel / local
  filesystem / local daemon state (local Docker engine, local cron
  table, local firewall, etc.). Recovery is deterministic.
- **Out of scope** — it makes a network call to something we don't
  control, OR the recovery requires reading current remote state to
  decide what to do.

Borderline cases already shipped that are fine because recovery is
canned (not remote-reasoning): `git-push-force` records the old remote
sha via `git ls-remote`, recovery force-pushes it back. `kubectl-delete`
for a single namespaced resource dumps manifest and re-applies. These
are "remote but canned." Future rules in the same class are OK if the
recovery is truly a one-liner replay; anything needing the subagent to
reason should be left to tier-3.

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

## Categories worth targeting (local only)

Already shipped, don't re-implement: `rm`, `chmod`, `chown`,
`outside-workspace-write-new`, `git-reset-hard`, `git-branch-delete-force`,
`git-stash-drop`, `git-push-force`, `docker-rm`, `docker-volume-rm`,
`docker-image-rm`, `kubectl-delete` (single namespaced resource).

Ranked by impact × ease:

### High impact, high confidence — write these next

- **`truncate --size=0 <file>` / `truncate -s 0 <file>`** — atomic file
  zeroing. Rule: `mv` file to trash first, then rewrite the command to
  `true`. Same shape as `rm-to-trash`.
- **`shred <file>` / `shred -u <file>`** — securely overwrite (and
  optionally unlink). Destructive by design, recoverable only if we
  preempt. Same `mv`-to-trash pattern. Reject recursive (`-r`).
- **`dd of=<file> …` / `dd if=/dev/zero of=<path>`** — overwrites
  destination. `mv` existing destination to trash first; the user's
  `dd` still runs against the now-nonexistent path (creates a fresh
  file).
- **`ln -sf <src> <dst>`** where `dst` already exists — symlink
  overwrite. `mv dst` to trash first.
- **`docker system prune -f` / `docker system prune -af`** — THE
  classic "oh shit" docker command. Pre-snapshot `docker ps -aq --filter status=exited`,
  `docker images -q --filter dangling=true`, `docker volume ls -q --filter dangling=true`,
  `docker network ls -q`, save per-object metadata (inspect output) to
  trash, then let prune run. Recovery replays `docker load`,
  `docker volume create`, `docker network create` for each saved
  object that was actually pruned. Same idea for `docker builder prune`.
- **`docker compose down`** (without `-v`, which we'd handle like
  volume rm) — remove containers + networks. Dump `docker compose config`
  to trash first; recovery `docker compose up -d` from the saved
  compose file.
- **`helm uninstall <release>`** — local helm client operating against
  a reachable cluster. Rule: `helm get manifest <rel> > trash/manifest.yaml`,
  `helm get values <rel> > trash/values.yaml`, `helm get hooks <rel> > trash/hooks.yaml`.
  Recovery: `helm install <rel> -f trash/values.yaml <chart>` (chart
  reference recorded separately from `helm list --filter`).
- **`iptables -F` / `iptables -X` / `nft flush ruleset`** — wipes local
  firewall rules. Pre-save with `iptables-save > trash/rules.v4` (or
  `nft list ruleset > trash/nft.conf`); recovery `iptables-restore` /
  `nft -f trash/nft.conf`. Requires root — return null otherwise.

### Medium impact — worth having

- **`git filter-repo` / `git filter-branch`** — local history rewrite.
  Pre-save every ref tip: `git for-each-ref --format='%(refname) %(objectname)' > trash/refs.txt`.
  Recovery iterates and runs `git update-ref <ref> <sha>` per line.
- **`git reflog expire --expire=now --all`** / **`git gc --prune=now`**
  — destroys the safety net itself. Pre-save reflog via
  `git reflog --all --date=raw > trash/reflog.txt`. Recovery is
  best-effort (the reflog format isn't trivial to restore mechanically);
  mark `confidence: "medium"` and include a human-readable note in
  the description.
- **`rm -rf node_modules` / `rm -rf target/` / `rm -rf build/`** —
  technically covered by `rm-to-trash`, but these directories can be
  gigabytes. If we pre-archive them with `tar cf` into trash with
  hard-link mode (`--hard-dereference=no`, on same FS preserves
  inodes), recovery is cheaper than re-downloading. Match by
  well-known cleanup targets: `node_modules`, `target`, `build`,
  `dist`, `.next`, `.nuxt`, `__pycache__`, `.pytest_cache`, `coverage`.
  Fall through to the normal `rm-to-trash` if no match.
- **`make clean` / `cargo clean` / `npm run clean`** — invoke arbitrary
  cleanup. Record `pwd` + the command, offer no direct recovery (most
  of these are re-build-from-scratch anyway). Mark `confidence: "low"`.
  Or skip entirely — often not worth a rule.
- **SQL against a LOCAL socket only** (`psql` / `mysql` / `sqlite3`
  without a host flag, or with `-h localhost` / `-h 127.0.0.1`):
  - `DROP TABLE <t>` → rewrite to `ALTER TABLE <t> RENAME TO _chats_trash_<t>_<ts>` (Postgres/MySQL). Recovery renames back.
  - `DELETE FROM <t> WHERE <pred>` → `CREATE TABLE _chats_undo_<ts> AS SELECT * FROM <t> WHERE <pred>`, then delete. Recovery `INSERT INTO <t> SELECT * FROM _chats_undo_<ts>`.
  - Out of scope when `-h <remote-host>` is present (that's tier-3).

### Niche but interesting (write if a specific pain point motivates)

- **`rsync --delete` / `rsync --delete-after`** — destination-side file
  deletion. `rsync` itself has a `--backup --backup-dir=<trash>` flag
  pair; the rule rewrites to add those flags. O(1) rename on the same
  FS, zero extra I/O.
- **`tar --delete`** on an archive — archive manipulation. Copy the
  archive to trash first, then run. `cp` is O(N) here but archives
  are usually smaller than the files they contain, so worth it.
- **Redis `FLUSHDB` / `FLUSHALL`** — local Redis only. Pre-dump via
  `redis-cli --rdb trash/dump.rdb` or `redis-cli BGSAVE` +
  `cp /var/lib/redis/dump.rdb trash/`. Recovery reloads the rdb.
- **MongoDB `db.collection.drop()` / `deleteMany`** via `mongosh` on
  `localhost` — pre-dump with `mongodump --out trash/...` Recovery via
  `mongorestore`.
- **Shell-redirection truncation** (`> file`, `>| file`) — not a
  command, it's bash syntax. Hard to safely match with a regex; the
  false-positive rate on things like `log > output.txt` inside a
  larger command is high. Probably skip unless you can constrain to
  a narrow form (e.g., command starts with `>`).
- **`update-alternatives --remove`** (Debian-alternative switching) —
  capture current selection with `update-alternatives --query` first;
  recovery restores via `--install`.
- **`apt purge` / `dpkg --remove`** — package system destruction.
  Tier-1 already captures `pip freeze` / `npm list`; could add
  `dpkg --get-selections` for `apt`. Record before, recovery is
  `apt install <list>` or `xargs -a selections dpkg --set-selections`.

### Explicitly out of scope (tier-3 handles)

- **Cloud provider CLIs**: `aws`, `gcloud`, `az`, `doctl`, `oci`, `linode-cli`
- **HTTP DELETEs**: `curl -X DELETE`, `httpie DELETE`
- **IaC against remote**: `terraform destroy/apply`, `pulumi destroy`
- **Push-to-remote**: `docker push`, `helm push`, `git push` without `--force` (push itself isn't destructive — tier-3 handles)
- **Remote package registries**: `npm unpublish`, `cargo yank`, `pip` pushing to PyPI
- **Remote database hosts**: any DB client with `-h <non-local-host>`
- **Cluster-wide kubectl**: `kubectl delete namespace`, `kubectl delete crd`, `kubectl delete --all`, `kubectl delete -l <selector>`, `kubectl delete --all-namespaces`
- **Things that are "really destructive but not data":** `systemctl stop`, `launchctl unload`, `killall` — service state is re-enterable, not data-lost. Skip.

## Your task

Given the categories listed by the user (or "all high-impact categories
from the 'High impact, high confidence — write these next' section" if
none listed), generate a single TypeScript module:

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
