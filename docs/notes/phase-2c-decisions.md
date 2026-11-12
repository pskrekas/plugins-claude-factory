# Phase 2c ("the builder out of reach"): decisions

Plan: `docs/superpowers/plans/2026-11-12-phase-2c-container.md`. Built on branch
`phase-2c-container`, 2026-11-12. 461 tests. An automated security review read every
commit; a fresh reviewer read the whole branch at the end, with its own tests on real
git and Docker.

## The decision that changed the plan

**A builder's command gets a container of its own, not one container for each job.**
The plan made one container when a job started and ran each command in it with
`docker exec`. A program that a command leaves alive in such a container can change a
path of the job's folder (a file for a link) while the person's machine reads that
folder: a file tool of an agent, the plugin's `git add`, a removal. So each command is
`docker run --rm`: the container is gone when the command ends, with every program the
command started (checked on real Docker with `&`, `nohup` and `setsid`; about 0.2 s
for each command).

What follows from it:

- Only the files of the code folder stay between two commands. A package cache
  outside the folder (`HOME=/tmp`) is lost, so a second install downloads again.
- A file tool on the person's machine and a command in a container never run at the
  same time for one job (the plugin's `tool.call` hook holds the rule both ways).
- The fence judges a file call again at the moment it runs, not only when the engine
  asks: a command that ended in between may have turned a part of the path into a link.
- A container is removed by name after its command, also after a time limit. While
  docker does not say that it is gone, the job's folder stays closed: no file call, no
  command, no commit, no removal.

## The job's folder is hostile on the person's machine

The final review showed three ways out that the fake test machine could not see. Each
was confirmed on real git 2.50.1 and Docker Desktop 29.5.3, fixed, and tried again.

1. **Nothing inside the folder is the source of a mount.** The first build mounted the
   folder's `.git` file read-only on its own. On a disk that does not tell `.GIT` from
   `.git` (the macOS default) a command could move that file by another spelling, put
   a link to any file of the person in its place, and the next command's mount made
   docker follow the link. The mount is gone. A changed `.git` file now only stops
   the job: the plugin's check of it (`worktreeGitDir`) refuses a link and a pointer
   that does not point back. And after each command, when its container is gone, the
   plugin puts the folder's own `.git` file back as git made it (`healGitFile`), and
   removes any other entry named `.git` at the top: a `git` that a person, the engine
   or a tool runs in that folder must not read a repository the builder put there.
2. **No git call on a folder that holds a git repository of its own.** Git starts a
   second git inside such a repository (`status`, `add`, `commit`), and that one reads
   the inner repository's own settings: a `filter` there is a program on the person's
   machine. `core.fsmonitor=false` stopped only one such program. Before every git
   call on a job's folder the plugin now runs `find <folder> -mindepth 1 -iname .git
   -print` and goes on only when the one entry is the folder's own `.git`. Cost: a
   repository whose builder must fill in a submodule cannot use the line.
3. **No folder is removed while a container of its job may be alive.** `git worktree
   remove --force` follows a parent folder that is swapped for a link, and deletes
   outside the job. A reject, the end of a job and the end of a gate run now first get
   docker's word that the job's containers are gone; without it the folders stay and
   the person is told.

## Decisions made while building

1. **Container names hold the kind, the job and the repository**
   (`factory-job-<job>.<label>`, `factory-gate-<job>.<label>`). The plan's names let a
   job id that starts with `gate-` equal a gate's name, and let two repositories share
   one. A job id holds no `.`, so a name reads one way only.
2. **The container settings are the base branch's, with the approval check**, for the
   gate, for the builder's shell and for a new job. The settings file of a working
   tree names no image. Cost: two git reads every five seconds while a builder runs
   commands.
3. **"On this machine" needs an approval too.** `"container": false` shows as
   `[container] none: the builder and the gate run on this machine`, and counts only
   when that line is approved.
4. **A job says where its builder runs** (`Job.shell`), set once when the job is made.
   A job file from before this phase reads as `host`.
5. **The shell tool answers one agent only:** the builder that is at work now on a
   job that builds in a container and is in Build. A builder the line gave up on runs
   no command.
6. **The fence refuses a `Bash` call of a container builder** (the plan said: not
   answered). Its agent type holds no `Bash`; the refusal is the second lock.
7. **The plugin commits the builder's work** with `git add -A` and a fixed message.
   It reads what is staged and refuses a gitlink (a second net behind decision 2 of
   the part above).
8. **The gate's container is always made new**, and the image's own start program is
   not used (`--entrypoint`). Docker is told to fetch no image (`--pull never`).
9. **A second `/factory run` in the session that runs the line removes no container.**
   The sweep of containers that were left runs only when the session did not hold the
   lock before the call.
10. **A check that cannot be made refuses the call.** The engine skips a hook that
    throws and runs the tool; the plugin's file-call, shell and fence hooks now answer
    with a refusal when their own check fails.
11. **`/factory init` names an image** (`node:22` for an npm repository, `python:3.12`
    for a Python one). For any other repository the person names one.
12. **The network is `on` by default** so that an install works. With it on, a
    container reaches the internet and the services of the person's machine and
    network (`host.docker.internal` on Docker Desktop). The README says so. `none`
    closes it; then the image must hold what the install needs. This default is the
    owner's to change.

## The forbidden commands in a container

`factory.forbiddenCommands` is a check of text, and it stays best effort: a command
built from pieces gets past it. In a container that is by design. The container is the
wall; it holds no login of the person, so such a command has nothing to act with. The
check compares words with quotes and backslashes taken out, looks into `sh -c`, and
refuses a command that holds a `$` or a backtick together with every word of a
forbidden command. A rule that refused every `$` would refuse most shell commands.

## Small findings, not fixed

- A builder that the line gave up on can still use its file tools inside the job (it
  runs no command). What it writes after the gate read a commit is not in that
  commit. The plugin cannot stop an agent (phase 2b).
- A git repository that a builder made in a folder below the top stays until a
  person removes it; the plugin makes no git call while it is there, but a `git` that
  a person runs inside that folder reads its settings.
- A job file from before this phase reads as `host`: a job of phase 2b that is still
  in flight keeps `Bash` after the person approved a container. No such job exists
  yet (the line has not run for real).
- When `git status` names a change and `git add -A` then stages nothing, the commit
  fails and the job asks. An empty staged list could count as "nothing new".
- A builder's command that exits 125 and prints a line that starts with `docker: ` is
  read as docker's own failure (and, with "already in use" in it, is run once more).
- A leftover folder of a job whose containers could not be stopped is removed by a
  later tidy of that job, not by a sweep of its own.
- `git` does not work inside a container (the git folder is not there). A gate
  command that needs it fails; a repository with such a gate needs `"container":
  false` or another command.
- The person's own global git filters (git-lfs) still run on the person's machine
  when the plugin adds a builder's files. They are the person's programs.
- From inside a container a builder can fill the disk through the mount, or leave a
  named pipe that hangs a file read on the person's machine. No limit is set.
- The plugin's commit carries the person's git identity and is not signed.
- `onSpawn` lets through any spawn with a well-formed description for a job that
  exists, and relies on the agent types not being offered to the model (phase 2b).
- After a reload, an agent the plugin no longer knows gets the engine's own answer
  for its file tools (phase 2b).
- Podman, rootless Docker and SELinux labels are not handled.

## Not checked on a real engine

- **What Claude Code reads from an agent's own folder.** An agent of the line starts
  in the job's worktree, which a builder writes. If the engine reads settings, hooks,
  an MCP file or skills from there, a builder could plant one for the next agent. The
  plugin cannot see this. Until the hand check (`docs/notes/r1-check.md`) shows that
  it does not, use the line only on issues you trust.
- That the plugin's `tool.call` hook sees every file tool call of an agent and that
  its refusal stops the call. The engine check (`r2c-check.md`) showed it for `Bash`
  and for the plugin's own tool.
- A command of ten minutes in `docker run` under a `tool.call` hook.
- Docker on Linux (who owns the files in the mounted folder).
- The whole line with a real engine: the hand check is not done.
