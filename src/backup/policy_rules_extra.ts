import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import * as path from "node:path";
import type { HookContext } from "../types.js";
import type { PolicyRule, PolicyRuleResult } from "./policy_rules.js";

/* -----------------------------------------------------------------------
 * EXTRA_RULES — tier-0 policy rules beyond the core `rm` rule in
 * policy_rules.ts. Each rule either:
 *   (a) run-and-rewrite — executes the destructive op inside apply(),
 *       then returns updatedInput={command:"true"} so Claude runs a
 *       noop. Used for git / docker / kubectl where we want to guarantee
 *       the destruction has happened (no race with hook return).
 *   (b) record-and-pass — captures pre-state, returns the original
 *       command unchanged. Used for chmod / chown (cheap stat capture)
 *       and outside-workspace-write-new (no state to capture, just
 *       record inverse).
 *
 * recoveryCommands are exact inverses executed verbatim by
 * `chats-sandbox restore` via execSync.
 *
 *   id                             category      confidence  description
 *   ------------------------------ ------------- ----------- --------------------------------------------------
 *   git-reset-hard                 git           high        Save HEAD sha before `git reset --hard`.
 *   git-branch-delete-force        git           high        Save branch sha before `git branch -D`.
 *   git-stash-drop                 git           high        Preserve stash commit under backup ref.
 *   git-push-force                 git           medium      Record remote sha before force-push.
 *   docker-rm                      container     medium      Commit container fs before `docker rm`.
 *   docker-volume-rm               container     high        Tar volume contents before `docker volume rm`.
 *   docker-image-rm                container     high        `docker save` image before `rmi`.
 *   kubectl-delete                 k8s           medium      Dump resource yaml before `kubectl delete`.
 *   chmod                          fs-overwrite  high        Save old mode, recover via chmod <old>.
 *   chown                          fs-overwrite  high        Save old owner, recover via chown <old>.
 *   outside-workspace-write-new    fs-delete     high        New file outside cwd: record rm as recovery.
 * ----------------------------------------------------------------------- */

// ---------- helpers --------------------------------------------------------

function shq(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function trashName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
  return cleaned.length > 0 ? cleaned : "item";
}

/**
 * Conservative compound-command detector. Single-quoted substrings are
 * stripped first so args like 'a;b' don't trip the check.
 */
function hasCompound(command: string): boolean {
  const stripped = command.replace(/'[^']*'/g, "");
  if (/[|&;`]/.test(stripped)) return true;
  if (/\$\(/.test(stripped)) return true;
  if (/<\(|>\(/.test(stripped)) return true;
  return false;
}

function runCaptured(cmd: string): string | null {
  try {
    return execSync(cmd, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function runSilent(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function which(cmd: string): boolean {
  try {
    execSync(`command -v ${shq(cmd)}`, { stdio: "pipe", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Tokenize a shell command honoring single/double quotes and backslash
 * escapes. Returns null on unterminated quote or dangling backslash.
 */
function tokenize(command: string): string[] | null {
  const tokens: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let pushed = false;

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (escaped) {
      cur += c;
      escaped = false;
      pushed = true;
      continue;
    }
    if (!inSingle && c === "\\") {
      escaped = true;
      continue;
    }
    if (!inDouble && c === "'") {
      inSingle = !inSingle;
      pushed = true;
      continue;
    }
    if (!inSingle && c === '"') {
      inDouble = !inDouble;
      pushed = true;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(c)) {
      if (pushed) {
        tokens.push(cur);
        cur = "";
        pushed = false;
      }
      continue;
    }
    cur += c;
    pushed = true;
  }
  if (inSingle || inDouble || escaped) return null;
  if (pushed) tokens.push(cur);
  return tokens;
}

function rawCommand(ctx: HookContext): string {
  const input = ctx.tool_input as { command?: unknown };
  return typeof input.command === "string" ? input.command : "";
}

function noopInput(ctx: HookContext): Record<string, unknown> {
  return { ...(ctx.tool_input as Record<string, unknown>), command: "true" };
}

function isHelpInvocation(tokens: string[]): boolean {
  return tokens.includes("--help");
}

function isSafePath(p: string): boolean {
  const t = p.trim();
  if (!t) return false;
  if (/[*?]/.test(t)) return false;
  if (/^(?:\/|~|\.|\.\.|\*)$/.test(t)) return false;
  if (/^\/(home|usr|var|etc|bin|sbin|lib|boot|dev|proc|sys|root|opt)\/?$/.test(t)) return false;
  return true;
}

// ---------- git reset --hard ----------------------------------------------

const gitResetHard: PolicyRule = {
  id: "git-reset-hard",
  category: "git",
  toolName: "Bash",
  pattern: /^\s*git\s+reset\s+(?:\S+\s+)*--hard\b/,
  confidence: "high",
  description:
    "Record HEAD sha before `git reset --hard` so the branch can be moved back on restore.",
  apply(_match, ctx, _trashDir) {
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;

    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;

    const head = runCaptured("git rev-parse --verify HEAD");
    if (head === null || !/^[0-9a-f]{7,64}$/.test(head)) return null;

    const shaFile = join(_trashDir, "git-reset-hard.sha");
    try {
      fs.mkdirSync(_trashDir, { recursive: true });
    } catch {
      return null;
    }
    const saveCmd = `printf %s ${shq(head)} > ${shq(shaFile)}`;
    if (!runSilent(saveCmd)) return null;

    if (!runSilent(command)) {
      return null;
    }

    return {
      updatedInput: noopInput(ctx),
      preCommands: [saveCmd, command],
      recoveryCommands: [`git reset --hard ${head}`],
      description: `Saved HEAD ${head.slice(0, 12)} before git reset --hard.`,
      ruleId: "git-reset-hard",
    };
  },
};

// ---------- git branch -D --------------------------------------------------

const gitBranchDeleteForce: PolicyRule = {
  id: "git-branch-delete-force",
  category: "git",
  toolName: "Bash",
  pattern: /^\s*git\s+branch\s+(?:\S+\s+)*(?:-D|--delete\s+--force)\b/,
  confidence: "high",
  description:
    "Capture branch sha before `git branch -D` so the ref can be recreated on restore.",
  apply(_match, ctx, _trashDir) {
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;

    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;

    const positional = tokens.slice(2).filter((t) => !t.startsWith("-"));
    if (positional.length !== 1) return null;
    const branch = positional[0];
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) return null;

    const sha = runCaptured(
      `git rev-parse --verify ${shq("refs/heads/" + branch)}`,
    );
    if (sha === null || !/^[0-9a-f]{7,64}$/.test(sha)) return null;

    if (!runSilent(command)) return null;

    return {
      updatedInput: noopInput(ctx),
      preCommands: [command],
      recoveryCommands: [`git branch -f ${shq(branch)} ${sha}`],
      description: `Captured sha ${sha.slice(0, 12)} of branch ${branch} before force-delete.`,
      ruleId: "git-branch-delete-force",
    };
  },
};

// ---------- git stash drop -------------------------------------------------

const gitStashDrop: PolicyRule = {
  id: "git-stash-drop",
  category: "git",
  toolName: "Bash",
  pattern: /^\s*git\s+stash\s+drop\b/,
  confidence: "high",
  description:
    "Preserve the stash commit under a backup ref before `git stash drop`; restore recreates stash@{0}.",
  apply(_match, ctx, _trashDir) {
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;

    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;

    const args = tokens
      .slice(3)
      .filter((t) => t !== "-q" && t !== "--quiet" && !t.startsWith("-"));
    if (args.length > 1) return null;
    const stashRef = args.length === 0 ? "stash@{0}" : args[0];
    if (!/^[A-Za-z0-9._@{}/-]+$/.test(stashRef)) return null;

    const sha = runCaptured(`git rev-parse --verify ${shq(stashRef)}`);
    if (sha === null || !/^[0-9a-f]{7,64}$/.test(sha)) return null;

    const backupRef = `refs/chats-sandbox/stash-${Date.now()}-${sha.slice(0, 8)}`;
    const backupCmd = `git update-ref ${shq(backupRef)} ${sha}`;
    if (!runSilent(backupCmd)) return null;

    if (!runSilent(command)) {
      runSilent(`git update-ref -d ${shq(backupRef)}`);
      return null;
    }

    return {
      updatedInput: noopInput(ctx),
      preCommands: [backupCmd, command],
      recoveryCommands: [
        `git stash store -m ${shq("chats-sandbox recovered stash")} ${sha}`,
        `git update-ref -d ${shq(backupRef)}`,
      ],
      description: `Backed up ${stashRef} (${sha.slice(0, 12)}) under ${backupRef} before drop.`,
      ruleId: "git-stash-drop",
    };
  },
};

// ---------- git push --force ----------------------------------------------

const gitPushForce: PolicyRule = {
  id: "git-push-force",
  category: "git",
  toolName: "Bash",
  pattern:
    /^\s*git\s+push\b(?=[^\n]*?\s(?:--force(?:-with-lease)?|-f)(?:=\S*|\b))/,
  confidence: "medium",
  description:
    "Record remote ref sha before `git push --force`. Remote may diverge before restore runs.",
  apply(_match, ctx, _trashDir) {
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;

    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;

    const positional: string[] = [];
    for (let i = 2; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith("-")) continue;
      positional.push(t);
    }
    if (positional.length !== 2) return null;
    const [remote, refspec] = positional;
    if (!/^[A-Za-z0-9._-]+$/.test(remote)) return null;

    const colonIdx = refspec.indexOf(":");
    const remoteRef = colonIdx >= 0 ? refspec.slice(colonIdx + 1) : refspec;
    const localRef = colonIdx >= 0 ? refspec.slice(0, colonIdx) : refspec;
    if (localRef.length === 0 || remoteRef.length === 0) return null;
    if (!/^[A-Za-z0-9._/-]+$/.test(remoteRef)) return null;

    const lsOut = runCaptured(`git ls-remote ${shq(remote)} ${shq(remoteRef)}`);
    if (lsOut === null) return null;

    let oldSha: string | null = null;
    if (lsOut !== "") {
      const firstLine = lsOut.split("\n")[0] ?? "";
      const candidate = firstLine.split(/\s+/)[0] ?? "";
      if (!/^[0-9a-f]{7,64}$/.test(candidate)) return null;
      oldSha = candidate;
    }

    if (!runSilent(command)) return null;

    const recoveryCommands: string[] =
      oldSha === null
        ? [`git push ${shq(remote)} --delete ${shq(remoteRef)}`]
        : [`git push --force ${shq(remote)} ${shq(oldSha + ":" + remoteRef)}`];

    return {
      updatedInput: noopInput(ctx),
      preCommands: [command],
      recoveryCommands,
      description:
        oldSha === null
          ? `Remote ${remote}/${remoteRef} did not exist before force-push; restore deletes it.`
          : `Recorded remote ${remote}/${remoteRef} at ${oldSha.slice(0, 12)} before force-push.`,
      ruleId: "git-push-force",
    };
  },
};

// ---------- docker rm ------------------------------------------------------

const dockerRm: PolicyRule = {
  id: "docker-rm",
  category: "container",
  toolName: "Bash",
  pattern: /^\s*docker\s+(?:container\s+)?rm\b/,
  confidence: "medium",
  description:
    "Commit container filesystem before `docker rm`. Restore via `docker create` from the recovery image; runtime state (ports, volumes, env) is NOT preserved — see inspect.json.",
  apply(_match, ctx, trashDir) {
    if (!which("docker")) return null;
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;

    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;

    let i = 1;
    if (tokens[i] === "container") i++;
    if (tokens[i] !== "rm") return null;
    i++;

    const containers: string[] = [];
    for (; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith("-")) continue;
      containers.push(t);
    }
    if (containers.length !== 1) return null;
    const container = containers[0];
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) return null;

    const id = runCaptured(`docker inspect --format={{.Id}} ${shq(container)}`);
    if (id === null || !/^[0-9a-f]{12,}$/.test(id)) return null;

    try {
      fs.mkdirSync(trashDir, { recursive: true });
    } catch {
      return null;
    }

    const safeLabel = trashName(container).toLowerCase();
    const recoveryImage = `chats-sandbox/recovery-${safeLabel}:${Date.now()}`;
    const inspectFile = join(trashDir, `docker-${safeLabel}.inspect.json`);

    const inspectCmd = `docker inspect ${shq(container)} > ${shq(inspectFile)}`;
    if (!runSilent(inspectCmd)) return null;

    const commitCmd = `docker commit ${shq(id)} ${shq(recoveryImage)}`;
    if (!runSilent(commitCmd)) return null;

    if (!runSilent(command)) {
      runSilent(`docker image rm ${shq(recoveryImage)}`);
      return null;
    }

    return {
      updatedInput: noopInput(ctx),
      preCommands: [inspectCmd, commitCmd, command],
      recoveryCommands: [
        `docker create --name ${shq(container)} ${shq(recoveryImage)}`,
      ],
      description: `Committed container ${container} as ${recoveryImage}; inspect saved to ${inspectFile}.`,
      ruleId: "docker-rm",
    };
  },
};

// ---------- docker volume rm ----------------------------------------------

const dockerVolumeRm: PolicyRule = {
  id: "docker-volume-rm",
  category: "container",
  toolName: "Bash",
  pattern: /^\s*docker\s+volume\s+rm\b/,
  confidence: "high",
  description:
    "Tar the volume contents into the action trash before `docker volume rm`; restore creates a fresh volume and untars back.",
  apply(_match, ctx, trashDir) {
    if (!which("docker")) return null;
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;

    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;
    if (tokens[0] !== "docker" || tokens[1] !== "volume" || tokens[2] !== "rm")
      return null;

    const volumes: string[] = [];
    for (let i = 3; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith("-")) continue;
      volumes.push(t);
    }
    if (volumes.length !== 1) return null;
    const volume = volumes[0];
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(volume)) return null;

    if (!runSilent(`docker volume inspect ${shq(volume)}`)) return null;

    try {
      fs.mkdirSync(trashDir, { recursive: true });
    } catch {
      return null;
    }

    const safeLabel = trashName(volume);
    const tarName = `docker-volume-${safeLabel}.tar`;
    const tarFile = join(trashDir, tarName);
    const backupCmd =
      `docker run --rm ` +
      `-v ${shq(volume + ":/v:ro")} ` +
      `-v ${shq(trashDir + ":/out")} ` +
      `busybox sh -c ${shq(`tar cf /out/${tarName} -C /v .`)}`;
    if (!runSilent(backupCmd)) return null;
    if (!existsSync(tarFile)) return null;

    if (!runSilent(command)) return null;

    return {
      updatedInput: noopInput(ctx),
      preCommands: [backupCmd, command],
      recoveryCommands: [
        `docker volume create ${shq(volume)}`,
        `docker run --rm ` +
          `-v ${shq(volume + ":/v")} ` +
          `-v ${shq(trashDir + ":/backup:ro")} ` +
          `busybox sh -c ${shq(`tar xf /backup/${tarName} -C /v`)}`,
      ],
      description: `Archived docker volume ${volume} to ${tarFile} before removal.`,
      ruleId: "docker-volume-rm",
    };
  },
};

// ---------- docker image rm / rmi -----------------------------------------

const dockerImageRm: PolicyRule = {
  id: "docker-image-rm",
  category: "container",
  toolName: "Bash",
  pattern: /^\s*docker\s+(?:image\s+rm|rmi)\b/,
  confidence: "high",
  description:
    "`docker save` the image tarball before `rmi`; restore via `docker load`.",
  apply(_match, ctx, trashDir) {
    if (!which("docker")) return null;
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;

    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;

    let i = 1;
    if (tokens[i] === "image") {
      i++;
      if (tokens[i] !== "rm") return null;
      i++;
    } else if (tokens[i] === "rmi") {
      i++;
    } else {
      return null;
    }

    const images: string[] = [];
    for (; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith("-")) continue;
      images.push(t);
    }
    if (images.length !== 1) return null;
    const image = images[0];
    if (!/^[A-Za-z0-9][A-Za-z0-9_./:@-]*$/.test(image)) return null;

    const resolved = runCaptured(
      `docker inspect --format={{.Id}} ${shq(image)}`,
    );
    if (resolved === null) return null;

    try {
      fs.mkdirSync(trashDir, { recursive: true });
    } catch {
      return null;
    }

    const safeLabel = trashName(image);
    const tarFile = join(trashDir, `docker-image-${safeLabel}.tar`);
    const saveCmd = `docker save ${shq(image)} -o ${shq(tarFile)}`;
    if (!runSilent(saveCmd)) return null;
    if (!existsSync(tarFile)) return null;

    if (!runSilent(command)) return null;

    return {
      updatedInput: noopInput(ctx),
      preCommands: [saveCmd, command],
      recoveryCommands: [`docker load -i ${shq(tarFile)}`],
      description: `Saved docker image ${image} to ${tarFile} before removal.`,
      ruleId: "docker-image-rm",
    };
  },
};

// ---------- kubectl delete -------------------------------------------------

const kubectlDelete: PolicyRule = {
  id: "kubectl-delete",
  category: "k8s",
  toolName: "Bash",
  pattern: /^\s*kubectl\s+delete\s+/,
  exclude:
    /\bkubectl\s+delete\s+(?:[^\n]*?\s)?(?:namespace|ns|crd|customresourcedefinition|clusterrole|clusterrolebinding|node|persistentvolume|pv|storageclass|-f|--filename|-l|--selector|--all|--all-namespaces|-A)\b/,
  confidence: "medium",
  description:
    "Snapshot a single namespaced resource via `kubectl get -o yaml` before `kubectl delete`; restore via `kubectl apply -f`.",
  apply(_match, ctx, trashDir) {
    if (!which("kubectl")) return null;
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;

    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;
    if (tokens[0] !== "kubectl" || tokens[1] !== "delete") return null;

    const positional: string[] = [];
    let namespace: string | null = null;
    for (let i = 2; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "-n" || t === "--namespace") {
        namespace = tokens[i + 1] ?? null;
        i++;
        continue;
      }
      if (t.startsWith("--namespace=")) {
        namespace = t.slice("--namespace=".length);
        continue;
      }
      if (t.startsWith("-")) continue;
      positional.push(t);
    }

    let kind: string;
    let name: string;
    if (positional.length === 2) {
      kind = positional[0];
      name = positional[1];
    } else if (positional.length === 1 && positional[0].includes("/")) {
      const parts = positional[0].split("/");
      if (parts.length !== 2) return null;
      kind = parts[0];
      name = parts[1];
    } else {
      return null;
    }
    if (!/^[A-Za-z][A-Za-z0-9.-]*$/.test(kind)) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
    if (namespace !== null && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(namespace))
      return null;

    try {
      fs.mkdirSync(trashDir, { recursive: true });
    } catch {
      return null;
    }

    const selector = `${kind}/${name}`;
    const nsFlag = namespace === null ? "" : ` -n ${shq(namespace)}`;
    const safeLabel = trashName(
      `${kind}-${name}${namespace === null ? "" : `-${namespace}`}`,
    );
    const yamlFile = join(trashDir, `kubectl-${safeLabel}.yaml`);

    const dumpCmd = `kubectl get ${shq(selector)}${nsFlag} -o yaml > ${shq(yamlFile)}`;
    if (!runSilent(dumpCmd)) return null;
    if (!existsSync(yamlFile)) return null;

    if (!runSilent(command)) return null;

    return {
      updatedInput: noopInput(ctx),
      preCommands: [dumpCmd, command],
      recoveryCommands: [`kubectl apply -f ${shq(yamlFile)}${nsFlag}`],
      description:
        `Snapshotted ${selector}` +
        (namespace === null ? "" : ` (namespace=${namespace})`) +
        ` to ${yamlFile} before delete.`,
      ruleId: "kubectl-delete",
    };
  },
};

// ---------- chmod (record-and-pass: stat, let user's chmod run) ----------

const chmodRule: PolicyRule = {
  id: "chmod",
  category: "fs-overwrite",
  toolName: "Bash",
  pattern: /^\s*chmod\s+\S+\s+\S+/,
  exclude: /[|;&`]|\$\(|-R\b/,
  confidence: "high",
  description: "Save old file mode before chmod; recover via chmod <old>.",
  apply(_match, ctx, _trashDir): PolicyRuleResult | null {
    const command = rawCommand(ctx);
    const tokens = tokenize(command);
    if (tokens === null) return null;
    const paths = tokens.slice(2).filter((t) => !t.startsWith("-"));
    if (paths.length === 0) return null;
    const preCommands: string[] = [];
    const recoveryCommands: string[] = [];
    for (const p of paths) {
      if (!isSafePath(p)) return null;
      const cwd = process.cwd();
      const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
      if (!fs.existsSync(abs)) return null;
      let mode = runCaptured(`stat -c %a ${shq(abs)}`);
      if (!mode) mode = runCaptured(`stat -f %Lp ${shq(abs)}`);
      if (!mode || !/^[0-7]{3,4}$/.test(mode)) return null;
      preCommands.push(`# recorded mode ${mode} for ${abs}`);
      recoveryCommands.push(`chmod ${mode} ${shq(abs)}`);
    }
    return {
      updatedInput: { ...ctx.tool_input },
      preCommands,
      recoveryCommands,
      description: `chmod (${paths.length} path${paths.length === 1 ? "" : "s"}, original modes recorded)`,
      ruleId: "chmod",
    };
  },
};

// ---------- chown (record-and-pass) -------------------------------------

const chownRule: PolicyRule = {
  id: "chown",
  category: "fs-overwrite",
  toolName: "Bash",
  pattern: /^\s*chown\s+\S+\s+\S+/,
  exclude: /[|;&`]|\$\(|-R\b/,
  confidence: "high",
  description: "Save old owner:group before chown; recover via chown <old>.",
  apply(_match, ctx, _trashDir): PolicyRuleResult | null {
    const command = rawCommand(ctx);
    const tokens = tokenize(command);
    if (tokens === null) return null;
    const paths = tokens.slice(2).filter((t) => !t.startsWith("-"));
    if (paths.length === 0) return null;
    const preCommands: string[] = [];
    const recoveryCommands: string[] = [];
    for (const p of paths) {
      if (!isSafePath(p)) return null;
      const cwd = process.cwd();
      const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
      if (!fs.existsSync(abs)) return null;
      let spec = runCaptured(`stat -c %u:%g ${shq(abs)}`);
      if (!spec) spec = runCaptured(`stat -f %u:%g ${shq(abs)}`);
      if (!spec || !/^\d+:\d+$/.test(spec)) return null;
      preCommands.push(`# recorded owner ${spec} for ${abs}`);
      recoveryCommands.push(`chown ${spec} ${shq(abs)}`);
    }
    return {
      updatedInput: { ...ctx.tool_input },
      preCommands,
      recoveryCommands,
      description: `chown (${paths.length} path${paths.length === 1 ? "" : "s"}, original owners recorded)`,
      ruleId: "chown",
    };
  },
};

// ---------- outside-workspace Write to NEW path -------------------------

const outsideWorkspaceWriteNew: PolicyRule = {
  id: "outside-workspace-write-new",
  category: "fs-delete",
  toolName: "Write",
  pattern: /.*/,
  confidence: "high",
  description:
    "Write to a NEW path outside cwd: no data to preserve, record rm as recovery (cheaper than escalating to tier-3 subagent).",
  apply(_match, ctx, _trashDir): PolicyRuleResult | null {
    const target = ctx.tool_input.file_path as string | undefined;
    if (!target || typeof target !== "string") return null;
    if (!path.isAbsolute(target)) return null;
    const cwd = process.cwd();
    if (!path.relative(cwd, target).startsWith("..")) return null;
    if (fs.existsSync(target)) return null;
    if (!isSafePath(target)) return null;

    return {
      updatedInput: { ...ctx.tool_input },
      preCommands: [`# outside-workspace create, no data captured`],
      recoveryCommands: [`rm ${shq(target)}`],
      description: `Write new file outside workspace (recovery: rm ${path.basename(target)})`,
      ruleId: "outside-workspace-write-new",
    };
  },
};

// ---------- registry -------------------------------------------------------

export const EXTRA_RULES: PolicyRule[] = [
  // Run-and-rewrite cluster (execute inside apply, noop back to Claude)
  gitResetHard,
  gitBranchDeleteForce,
  gitStashDrop,
  gitPushForce,
  dockerRm,
  dockerVolumeRm,
  dockerImageRm,
  kubectlDelete,
  // Record-and-pass cluster (capture state, original command runs as-is)
  chmodRule,
  chownRule,
  outsideWorkspaceWriteNew,
];
