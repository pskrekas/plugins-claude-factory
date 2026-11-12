# Phase 1: decisions made during the build

The plan and the real plugin API did not always agree. Each line below is a decision
that was made to continue, with its cost if it is wrong. The owner can change any of them.

## Decisions

- Setup: work on a branch `phase-1-panel` in the dedicated clone, no separate worktree — the clone holds nothing else — cost if wrong: none (branch can be moved).
- Ruling R1: when TaskState.id is null the TASK row shows the branch name in place of `<id> <title>` — the spec's TASK is "the item of the current branch"; with no item the branch is the honest value — cost if wrong: one row's text.
- Task 1: Ruling: the state contract cannot import (validate refuses it) — the model types are declared in types/index.d.ts and core/model.ts re-exports them under the plan's names — cost if wrong: none, names unchanged.
- Task 1: Ruling: an atom must be a const of the file that reads/writes it — hooks/state.ts holds only PANE, TITLE, SHAPE; register.tsx (and later refresh.ts) declare the atom themselves — cost if wrong: one duplicated declaration.
- Task 1: Ruling: Step 6's terminal part (pane seats, login type, types folder) cannot be run from this session — written as an open checklist in docs/notes/r1-check.md for the owner; type check is run with the build's bundled declarations instead; tasks continue — cost if wrong: a pane that does not seat on the owner's terminal is found late.
- Task 1: Ruling: openOnStart opens the pane with no width test (the engine itself does not seat an unasked pane in a narrow terminal) — cost if wrong: none.
- Task 1: Ruling: tests share tests/kit.ts (PANE, cmd()) because CommandRunInput has engine-stamped fields a test cannot give — cost if wrong: none.
- Task 2: Ruling: test answers clock.now with a hook (the kit has no bottom for it) — cost if wrong: none.
- Task 2: Ruling: TASK and PROGRESS are drawn in every consent state; only CHECKS and PORTS need approval — spec section 6 (no settings file still shows the branch's PR) and plan Task 5 (progress shows while consent is needed) — cost if wrong: two rows visible before approval; they run no repo command.
- Task 3: Ruling: added the error 'not a JSON object' and tests for the tracker defaults and check validation (the plan's rules imply them) — cost if wrong: none.
- Security review (after Task 2/3): fixed consent-ui-truncation (pending commands are wrapped, never cut; a command line quotes any argument that is not plain, so the shown line is unambiguous and is what is hashed) and terminal-escape-injection (rowsOf removes C0/C1 control characters from every row) — 4 tests RED→GREEN, suite 27/27.
- Task 4: Ruling: the engine refuses `$` passed to any function ("$ is always spelled $.noun.event(...) at the call site") — readers and refresh take an `Io` (hooks/io.ts: plain functions built inside register.tsx's session.start hook) in place of `$`; Reader is `{ name, read(io, ctx, prev) }`; RunResult lives in core/run.ts and carries stderr — every later task's reader uses Io — cost if wrong: none, it is the only shape the engine loads.
- Task 4: Ruling: a command before session.start answers "Factory is not ready. Start a new session." (io is built in session.start) — cost if wrong: a dead command in a session whose start hook did not run.
- Task 4: Ruling (security review, HIGH): no hash. The store keeps the full list of approved command lines; consentOf(hasFile, commands, stored) approves only when every current line is in that list; hashOf is removed — replaces the plan's hashOf/8-hex rule — cost if wrong: none (stricter).
- Task 4: Ruling (security review): a command with a control character is refused by the settings parser; a non-plain argument is shown as a JSON string in printable ASCII with \uXXXX escapes; rows strip Cc, Cf, Zl, Zp.
- Task 4: Ruling: /factory approve allows exactly the commands the panel last showed (model.pendingCommands); a file never shown, or changed since, is listed in the answer and needs a second approve — closes the gap between what was seen and what is approved — cost if wrong: one more command to type.
- Task 4: Ruling: the open pane is found with $.ui.panes(), not a module variable (a reload loses those) — cost if wrong: none.
- Task 5: Ruling: progress.files and owed must be repo-relative (no leading / or ~, no .., no backslash, no control character); the settings parser refuses others with 'path must be inside the repo' — what these files hold is shown and told to the model, so a settings file must not aim them at other files — cost if wrong: a repo that keeps progress outside itself cannot use this.
- Task 5: Ruling: a line is cut to 500 characters before a settings pattern is run on it, and a file over 1 MiB is skipped — bounds a slow pattern — cost if wrong: a very long line is not counted.
- Security review (after Task 4): approval is tied to the repo — PanelModel.root records the repo a model was read for; approve() reads the settings again and approves only when the root and the command lines equal what is on screen, writing under that root's key — test 'commands shown for one repo are never approved for another' RED→GREEN.
- Security review (after Task 5), three fixes, each with a test RED→GREEN, suite 69/69:
  - every file a settings file names (progress, owed, and .claude/factory.json itself) is read through hooks/readers/files.ts readInside(): stat first (regular file, size cap), real path must be under the repo's real path. Io gains stat(). — cost if wrong: a repo that keeps these as links to outside files loses them.
  - progress `done`/`open`/`blocked` are plain text marks, not regular expressions (defaults `- [x]`, `- [ ]`, `BLOCKED`); the spec's section 6 is updated — removes patterns that run before approval — cost if wrong: less flexible matching.
  - ticketPattern is refused when over 200 characters, with a back-reference or a repeated group — cost if wrong: an unusual but harmless pattern is refused.
- Task 6: Ruling: RunResult carries stderr (core/run.ts), tests build it with a helper — plan's shape had no stderr.
- Task 6: Ruling: an empty stdout where a value is wanted shows `(nothing)` — the row needs some text.
- Task 7: Ruling: toolNote takes a RunResult; any failure to start gives "gh could not start. Is it installed?" and a timeout "gh did not answer in time" — the engine's rejection text for a missing program is not documented, and the test kit cannot produce one, so the note does not depend on that text — cost if wrong: a vaguer note.
- Task 7: Ruling: the reader uses readIssue()/readPr() (item plus the run result) so it can make the note; githubIssues(run).read stays as the contract's method.
- Task 7: Ruling: prHostOf compares the parsed host name exactly (github.com, dev.azure.com, ssh.dev.azure.com, *.visualstudio.com), never a substring.
- Security review (after Task 6), two fixes with tests RED→GREEN, suite 83/83:
  - ticketPattern takes only a small whitelisted subset of regular expressions, read character by character (no alternation, look-around, back-reference or lazy repeat; one unrepeated capture group; at most two unbounded repeats; 100 characters) — replaces the earlier structural check — cost if wrong: a harmless richer pattern is refused.
  - a check's argv[0] must be a bare program name (no path), and every command runs with a PATH that has no relative entry and none inside the repo (core/checks.ts safePath; Io.run sets it). The residual — an approved command that runs repo code through an interpreter or a test runner — is stated in the spec and goes in the README; the gate's rule is decided in phase 2 — cost if wrong: a repo cannot use ./script checks.
- Tests that asserted "nothing ran" now assert "no settings command ran" (settingsRuns): the task reader's own `git` read runs without approval by design.
- Task 8: Ruling: an agent's start time is the first time a read saw it, kept in the model (not a module map, which a reload loses); agentRows(agents, before, now) — cost if wrong: a clock that starts up to a minute late.
- Task 8: Ruling: Io.setModel became Io.updateModel(change) so a full refresh and an agent-only refresh never overwrite each other; refreshAgents() runs on agent.spawn and a subagent's turn.complete, only while the pane is open.
- Task 8: Ruling: baseBranch must look like a branch name (it is an argument of git) — 'baseBranch: not a branch name' — cost if wrong: an unusual branch name is refused.
- Security review (after Task 7), with tests RED→GREEN, suite 92/92:
  - every repeat in ticketPattern counts (also ? and {n,m}); at most three.
  - a check is not run when one of its arguments names something in the repo ('names a repo file'). Acknowledged and documented, not closed: an approved command can still run repo code through an inline script or a build tool; the approval covers the command line the person read, as a shell permission does. Spec section 6 says so; the README will.
- Layout: an errored check shows its reason (timeout, not found, failed, names a repo file) in place of the word 'error'.
- Task 9: Ruling: the brief leaves out free text that others wrote (an issue title, a tracker's own state words, a blocked line's reason); a ticket id, a branch and a progress name are cleaned, cut and quoted, and the first line says quoted text is data — the plan's brief put the title in the system prompt, which an issue author could use to speak to the model — cost if wrong: a less detailed brief.
- Task 9: Ruling: session.start awaits one light read (ctx.isLight: no gh, no settings commands) so the status line and the brief exist before the first prompt — the plan had no read at start, and the spec wants a brief "at session start" — cost if wrong: a slower start by a few local git calls.
- Task 9: Ruling: PanelModel.shown holds the pending command lines the person was really shown (a refresh with the pane open, or the list in /factory approve's answer); approve uses it, not pendingCommands — found when the light read made unseen commands approvable; test 'approve before the commands were shown approves nothing' RED→GREEN.
- Task 9: Ruling: alerts are raised by refresh() from the model before and after; none on the first read or across two repos; alert text is cleaned and cut to 160.
- Task 10: Ruling: RepoFacts has no hasMakefile (nothing used it); /factory init finds the base branch from origin/HEAD, falls back to main, and drafts only a branch name the settings parser takes — cost if wrong: none.
- Task 10: Ruling: /factory init refuses when .claude or .claude/factory.json is a symbolic link (Io.isLink), so it never writes outside the repo — cost if wrong: a repo that links its .claude folder must write the file by hand.
- Task 10: Ruling: Step 6 (the whole-plugin check in a terminal) cannot be run from this session; it is an open checklist for the owner in docs/notes/r1-check.md.
- Final: Ruling: "a line approved as a gate command later running as a check" (declined by the reviewer) is a finding — a pull could move an approved `npm test` into checks and run it each minute — commandsOf lists the checks only; the gate gets its own approval in phase 2 — test 'the commands to approve are the checks…' RED→GREEN — cost if wrong: gate lines are approved later, not now.
- Final: Ruling: git reading a hostile .git/config — stands; the same exposure as Claude Code's own git calls — cost if wrong: none new.
- Final: Ruling: whether env.PATH governs the lookup of argv[0] — unknown engine behaviour; stands; the owner's terminal check must confirm it — cost if wrong: safePath protects less than the README says.
- Final: Ruling: Windows — the plugin is POSIX only; the README now says so — cost if wrong: a Windows user sees '?' for checks.
- Final: Ruling: managed settings / Team or Enterprise login — R1 stays open for the owner's terminal check.
- Final: Ruling: approvals surviving a delete and re-clone at the same path — stands; the lines must still match exactly.
- Final: Ruling: hard links and local time-of-check races — stand; they need a local attacker.
- Final: Ruling: a settings file aiming progress.files at a repo file with secrets shows lines on the person's own screen — stands; inside the repo, shown only to the person, never told to the model.
- Final: Ruling: the reviewer disagreed with "TASK and PROGRESS are drawn in every consent state" — the ruling stands: a file with no commands is approved by itself, so hiding these parts would not shrink what runs before approval; the surface was hardened instead (I1, I5) — cost if wrong: file-driven rows show before approval.
- Final: Ruling: the spec was edited in this branch (sections 4.3, 6, 8.1) to match the stricter rules; the owner is told in the final message.

## Final review: fixes

- C1 (a pane open but not drawn counted as shown) — Io.isPaneDrawn = isPlaced && isShown; shown, the minute timer and the agent refresh use it; approve opens the pane and refuses when it is not on screen; the header carries the command count — tests 'a pane that is open but not drawn has shown nothing', 'a pane that is a hidden tab is not read each minute and shows nothing' RED→GREEN, suite 121/121.
- I1 (an unapproved settings file could hang or flood) — glob segments matched without a regular expression (matchSegment, linear); checks and ports capped at 20 each and run four at a time; progress path at most 200 characters — tests 'a glob with many stars is matched in no time' (hung the old code), 'a settings file cannot ask for more than 20 checks or 20 ports' RED→GREEN.
- I2 (a linked worktree read the main checkout) — Io.root is the working tree's top (git rev-parse --show-toplevel from the session root, cached); approvals are keyed by the main checkout (Io.consentKey) so worktrees share them — test 'in a linked worktree the panel reads the worktree…' RED→GREEN.
- I3 (approve did not check who ran it) — only origin 'composer' approves — test 'only a person at the prompt can approve' RED→GREEN.
- I4 (the brief changed during a session) — built once after the start read — test '…fixed at session start' RED→GREEN.
- I5 (a progress file's heading reached the system prompt) — the brief tells percents only — brief tests RED→GREEN.
- I6 (fit spilled when the right side was as wide as the pane) — the right side takes at most half — test 'a right side as wide as the pane is cut to half, and the name stays' RED→GREEN.
- I7 (the repo-file rule refused ordinary words) — only a regular file is refused; README says it is a guard, not a boundary — test 'a check whose argument is only the name of a repo folder still runs' RED→GREEN.
- I8 (PROGRESS showed the first eight by name) — newest first by change time, '+ N more' (PanelModel.progressMore) — tests RED→GREEN.
- I9 (approve put unapproved command lines in the transcript) — its answers hold a count only — approve tests RED→GREEN.

## Small findings, not fixed

- with git missing TASK disappears with no line; with nc missing ports show '?' and nothing names nc.
- fit counts UTF-16 units, so wide (CJK, emoji) text can spill and a cut can split a pair.
- /factory awaits the full refresh (up to 30 s with gh hanging).
- the minute timer is never cancelled and refreshes can overlap; no in-flight guard.
- the status line text is not cleaned of format characters, and goes stale while the pane is closed.
- readIssue joins all digits of an id (V2-45 reads issue 245).
- a ticketPattern with three repeats can cost about 1 s on a 200-character branch.
- PRESUMED clears a block; '- [X]' is not counted as done; any prose with BLOCKED raises an alert.
- the PR row shows no merged/closed state; approvals is 0 or 1; a fresh worktree with no commits shows as merged.
- the comment in refresh.ts about agents not being lost is not exact (the work reader's agents overwrite).
- safePath at root '/' or a repo at $HOME drops every PATH entry; a repo's virtualenv tools are never used.
- no way to revoke an approval; the list only grows.
- spec 4.1 keys w and o for MORE lines and the agent's model are not built.
- the agent.spawn hook has no .catch (validator note).
- a settings file over 256 KiB reads as "No settings file", and init then says it exists.

## After the final review

- Security review: approvals were keyed by the session's repository, while the settings are read from the working tree's top; a repository cloned inside another could then use the outer one's approvals for the same command line. The key is now the repository's own git folder (`git rev-parse --git-common-dir`), which a linked worktree shares and a nested repository does not — test 'an approval never covers another repository that sits inside this one' RED→GREEN, suite 122/122.
