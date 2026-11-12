# Factory Plugin, Phase 2c: The Builder Out Of Reach — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No command that an agent chose, and no code that an agent wrote, runs on the person's machine. The builder's commands and the gate's commands run in a container that sees only the job's folder.

**Architecture:** The builder agent type loses `Bash` and gets one tool of the plugin (`mcp__factory__sh`); the plugin's `tool.call` hook runs each command with `docker exec` in the job's container. Every `docker` call is a fixed argument list from one pure file (`core/container-args.ts`), as every `git` call is. The gate gets its own container over its clean copy. The git folder is not in a container, so the plugin commits the builder's work. The container's image, network and limits are settings of the base branch, approved by the person.

**Tech Stack:** as before, plus the `docker` command of the person's machine. No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-12-factory-plugin-design.md`, section 8.3. Also binding: `docs/notes/r2c-check.md`.

**Not in this plan:** podman, a virtual machine, a network allow list, building an image, a container for the other agents (they have no shell).

## Global Constraints

- Everything in the earlier plans' Global Constraints still holds.
- **Arguments, never a shell on the person's machine.** A command of the builder is one argument of `sh -c` *inside* the container. No text of an agent is ever part of a command line that the person's machine reads.
- **A container sees one folder.** The only mount is the job's worktree (or the gate's clean copy), at its own path. Never the home folder, the repository, its git folder, the state folder, or the Docker socket. Never `--privileged`; always `--cap-drop ALL` and `--security-opt no-new-privileges`. A test lists every `docker` argument list this plan can build and checks these rules.
- **The plugin fetches no image** and builds none.
- **The container settings are the base branch's and are approved**, like the gate's commands.
- **Host mode is an explicit choice** (`"container": false`), approved as its own line. With no `container` key the line does not run.

**Commands used by every task**

```bash
claude plugin validate factory
claude plugin test factory
npx -p typescript tsc -p factory
```

## Review Focus

1. **A builder that tries to leave the container** (a mount, the Docker socket, `--privileged`, another container). No argument list holds any of these; the builder cannot name a `docker` option, only the text of a command inside. (Tasks 2, 5)
2. **Docker is not there, not running, or the image is missing.** `/factory run` refuses with one line that says what to do; a job in flight asks the person; nothing falls back to the person's machine. (Tasks 3, 6)
3. **A command that never ends, or prints 50 MB.** The call ends at its time limit; the output is cut and says so; the container is still removed when the job ends. (Tasks 3, 5)
4. **Containers left behind** (a crash, a closed session, a rejected job). A new `/factory run` removes the containers of jobs that are gone and reuses or remakes the one of a job that goes on. (Tasks 3, 6)
5. **A job branch that changes the container settings.** They are read from the base branch and approved; a job's own settings file changes nothing. (Tasks 1, 4, 6)

## File Structure

```
factory/core/factory-settings.ts   + container: { image, network, memory, cpus } | false | null
factory/core/settings.ts           + the container's approval line
factory/core/container-args.ts     every docker call, as an argument list
factory/hooks/container.ts         make, run in, remove, sweep; the image check
factory/core/git-args.ts, hooks/worktrees.ts   + the plugin's commit of a job's work
factory/core/agents.ts, agents/prompts.ts      the builder with the plugin's shell tool; no git for the builder
factory/hooks/agent-events.ts, register.tsx    the shell tool's hook
factory/hooks/gate.ts              the gate's commands in a container
factory/hooks/line.ts, start.ts    the job's container, the commit, the checks of /factory run
```

---

### Task 1: The container settings and their approval

**Files:** Modify `factory/core/factory-settings.ts`, `factory/core/settings.ts`. Test: `factory/tests/factory-settings.test.ts`, `factory/tests/gate-approval.test.tsx`.

**Interfaces:**
- `type ContainerSpec = { image: string; network: 'on' | 'none'; memory: string; cpus: number }`. `FactorySettings.container: ContainerSpec | false | null` (default `null`).
- Rules: `image` is 1 to 200 characters of `A-Z a-z 0-9 . _ / : @ -`, does not start with `-` or `.`; `network` default `on`; `memory` is digits and `m` or `g` (default `4g`); `cpus` 0.5 to 16 (default 2). `false` is host mode. A wrong value refuses the whole `factory` key.
- `containerLine(container): string | null`: `[container] <image> · network <on|none> · memory <m> · cpus <n>`, or `[container] none: the builder and the gate run on this machine` for `false`, or null. `commandsOf(settings)` adds it last.

- [ ] **Step 1: Failing tests:** the defaults; each bad value (`image` `--privileged`, `a b`, empty; `network` `host`; `memory` `lots`; `cpus` 0, 99) refuses the key; `commandsOf` ends with the line; `false` gives the host line; the pane lists the line and `/factory approve` allows it.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: container settings, approved like a gate command"`

### Task 2: Every docker call, as an argument list

**Files:** Create `factory/core/container-args.ts`. Test: `factory/tests/container-args.test.ts`.

**Interfaces:**
- `containerName(kind: 'job' | 'gate', jobId, label): string | null` = `factory-job-<jobId>.<label>` / `factory-gate-<jobId>.<label>` (the label is the name of the repository's state folder; a job id holds no `.`, so no two jobs, kinds or repositories share a name; ruling in Task 3).
- `dockerArgs(call): string[] | null` for: `{ do: 'image'; image }` → `docker image inspect --format {{.Id}} <image>`; `{ do: 'make'; name; spec; folder; user; label }` → `docker run -d --name <name> --label factory.state=<label> --init --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory <m> --cpus <n> --network <bridge|none> --user <uid>:<gid> -e HOME=/tmp -v <folder>:<folder> -w <folder> <image> sleep infinity` (for `kind` job also `-v <folder>/.git:<folder>/.git:ro` when `hasGitFile`); `{ do: 'running'; name }` → `docker inspect --format {{.State.Running}} <name>`; `{ do: 'shell'; name; cwd; command }` → `docker exec -w <cwd> <name> sh -c <command>`; `{ do: 'argv'; name; cwd; argv }` → `docker exec -w <cwd> <name> <argv…>`; `{ do: 'remove'; name }` → `docker rm -f <name>`; `{ do: 'list'; label }` → `docker ps -a --filter label=factory.state=<label> --format {{.Names}}`.
- Null when a value breaks a rule: a name that is not `factory-…` of a job id, a folder that is not a plain absolute path, an image or spec that Task 1 would refuse, a `user` that is not `digits:digits`, an empty `argv`, a command over 100,000 characters.

- [ ] **Step 1: Failing tests:** each list word for word; the null cases; the rule test over every list (`--privileged`, `--pid`, `--ipc`, `--cap-add`, `--device`, `docker.sock`, `--volumes-from`, `--mount` never appear; exactly the given folder is mounted; `--cap-drop ALL` and `no-new-privileges` are in every `make`); a command with quotes, `$(…)`, new lines and a leading `-` is one argument after `sh -c`.
- [ ] **Step 2–4.** **Step 5: Commit** — `git commit -m "feat: every docker call as an argument list"`

### Task 3: Make, use and remove a container

**Files:** Create `factory/hooks/container.ts`. Test: `factory/tests/container.test.ts`.

**Interfaces:**
- `dockerState(io, image): Promise<{ ok: true } | { ok: false; why: string }>`: `docker is not on this machine`, `docker does not answer`, or `the image <image> is not on this machine. Run: docker pull <image>`.
- `ensureContainer(io, root, jobId, kind, spec): Promise<{ ok: true; name: string; folder: string } | { ok: false; why: string }>`: the folder is the job's worktree (`job`) or the gate's clean copy (`gate`); a container of that name that runs is reused; one that does not run is removed and made again.
- `runShell(io, name, cwd, command, timeoutMs): Promise<{ text: string; exitCode: number | null }>` (`text`: `exit <n>`, then the end of both streams, at most 30,000 characters, with a line when it was cut or timed out); `runArgv(io, name, cwd, argv, timeoutMs): Promise<RunResult>`.
- `removeContainer(io, name): Promise<void>`; `sweepContainers(io, root, keep: string[]): Promise<number>` removes every container with this repository's label whose name is not in `keep`.

- [ ] **Step 1: Failing tests** with `fakeIo` answering `docker …`: the three `dockerState` texts; reuse, remake, and a `make` that fails; a shell call that times out says so; output of 100,000 characters is cut to its end; the sweep removes only the others; no test line holds `sh -c` outside a `docker exec`.
- [ ] **Step 2–4.** **Step 5: Commit** — `git commit -m "feat: a container for a job"`

### Task 4: The plugin commits the builder's work

**Files:** Modify `factory/core/git-args.ts`, `factory/hooks/worktrees.ts`, `factory/hooks/line.ts`, `factory/agents/prompts.ts`. Test: `factory/tests/worktrees.test.ts`, `factory/tests/line-run.test.ts`, `factory/tests/agents.test.ts`.

**Interfaces:**
- `gitArgs`: `{ do: 'add-all'; gitDir; workTree }` → `<in-tree prefix> add -A`; `{ do: 'commit'; gitDir; workTree; message }` → `<in-tree prefix> commit --no-verify --no-gpg-sign -m <message>`; the message is `Factory: item <digits and letters>, round <n>` only (a rule of `gitArgs`).
- `commitAll(io, root, job): Promise<Done & { isNew?: boolean }>`: nothing to commit is ok with `isNew: false`.
- `line.ts`: at `build → gate`, `commitAll` first; a failure is a failed step.
- Prompts: the builder is told that it has no git and that the line commits what it leaves.

- [ ] **Step 1: Failing tests:** the two lists word for word; a message with any other text gives null; the "cannot force…" rule test allows `commit` only in this form; `commitAll` with a clean and a dirty worktree; the main path shows `add -A` and `commit` before the gate; the builder's prompt.
- [ ] **Step 2–4.** **Step 5: Commit** — `git commit -m "feat: the plugin commits a job's work"`

### Task 5: The builder's shell is the plugin's tool

**Files:** Modify `factory/core/agents.ts`, `factory/agents/prompts.ts`, `factory/core/job.ts` (`Job.shell: 'container' | 'host'`, default `host` for an old file), `factory/hooks/agent-events.ts`, `factory/hooks/register.tsx`, `factory/core/fence.ts`. Test: `factory/tests/agents.test.ts`, `factory/tests/agent-events.test.ts`, `factory/tests/agents-engine.test.tsx`.

**Interfaces:**
- `SHELL_TOOL = 'mcp__factory__sh'`. Two builder types: `factory:builder` (`Read, Glob, Grep, Write, Edit, mcp__factory__sh`) and `factory:builder-host` (`…, Bash`). `typeOf(role, shell)`.
- `register.tsx`: `$.tool.register({ name: 'sh', description, inputSchema: { command: string, timeout_ms?: number } })`; `on('tool.call', { tool: SHELL_TOOL })` answers `{ result }` from `onShell`, or `{ deny }`.
- `onShell(io, e: { agentId?; command?; timeout_ms? }): Promise<{ result: string } | { deny: string }>`: only for a builder of a job whose `shell` is `container`; anyone else gets `{ deny: 'This tool is for the builder of the factory line.' }`. It makes sure the job's container is there and runs the command in the worktree with a time limit of 2 minutes by default and 10 at most.
- Fence: for `SHELL_TOOL`, allow, except a command of `forbiddenCommands` (deny, and a refusal fact). The text rules of the shell stay for `Bash` (host mode) only. A container builder that calls `Bash` is not answered by the fence (the type has no `Bash`).

- [ ] **Step 1: Failing tests:** the two types and their tools; the container builder's prompt names the tool and holds no `Bash`; `onShell` for a builder, for the session's model, for a reviewer, for a host job; the command reaches `docker exec … sh -c <command>` unchanged; a forbidden command is refused before any docker call; engine: the tool is registered and a call with no agent is denied.
- [ ] **Step 2–4.** **Step 5: Commit** — `git commit -m "feat: the builder's shell runs in the job's container"`

### Task 6: The gate in a container, and the checks of `/factory run`

**Files:** Modify `factory/hooks/gate.ts`, `factory/hooks/line.ts`, `factory/hooks/start.ts`. Test: `factory/tests/gate.test.ts`, `factory/tests/line-run.test.ts`.

**Interfaces:**
- `gateCommands` also answers `container: ContainerSpec | false | null` of the base branch, and refuses (`the container settings are not approved`) when its line is not on the approved list.
- `runGate(io, root, job, base, which)`: with a `ContainerSpec` it makes `factory-gate-<job>.<label>` over the clean copy, runs each command with `runArgv`, and removes the container with the copy. With `false` it runs as before. With `null`: `{ pass: false, why: 'no container is set', needsPerson: true }`.
- `startRun`: refuses with `No container, no factory: set factory.container in the settings file on the base branch (an image, or false to run on this machine).`, with `the container settings are not approved. Approve them with /factory approve.`, or with `dockerState`'s line; then `sweepContainers`.
- `line.ts`: a new job gets `shell` from the base's container settings and, for `container`, its container (`ensureContainer`) after its worktree; `tidy` removes the job's containers.

- [ ] **Step 1: Failing tests:** the gate's commands are `docker exec … npm test` in `factory-gate-<job>.<label>`, never a bare `npm test`; the container is removed after a pass and after a fail; host mode runs as before; the three refusals of `/factory run`; a new job's container is made with the worktree as its one mount; a job that ends has no container; a job's own settings file with another image changes nothing.
- [ ] **Step 2–4.** **Step 5: Commit** — `git commit -m "feat: the gate runs in a container; no container, no factory"`

### Task 7: README, notes, hand check

- [ ] **Step 1: README:** "Before you run the line" says where commands run now and what the container can and cannot reach; a "The container" part (the settings, how to get the image, network `on` or `none`, host mode and what it means); every `docker` call in the list of calls; troubleshooting for the three docker refusals.
- [ ] **Step 2: `docs/notes/r1-check.md`:** the hand check uses a container (`node:22`), and adds: `docker ps` shows `factory-job-<job>.<label>` while a job runs and nothing after; the builder's `whoami` and `ls /Users` inside the tool.
- [ ] **Step 3: Run all three commands** — PASS. **Step 4: Commit** — `git commit -m "docs: the builder out of reach"`
