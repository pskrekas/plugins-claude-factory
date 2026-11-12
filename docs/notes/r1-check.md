# R1 check (design section 12)

## Checked without a terminal session (2026-11-12)

- Claude Code 2.1.322 on macOS. No managed settings file on the machine.
- `claude plugin validate factory`: passed. It lists the hooks `session.start`,
  `command.run{command=factory}` and `ui.render{component=Pane}`.
- `claude plugin test factory`: the pane mounts on `terminal`, `desktop`,
  `vscode` and `mobile`.
- Type check with the build's own declarations: no errors.

Two rules of the mod API found here, which the plan did not know:

- The state contract (`types/index.d.ts`) must be self-contained: no import.
  The model's types are declared there; `core/model.ts` re-exports them.
- A `$.state` atom must be a const of the file that calls `read` or `update`
  on it. It cannot be imported from another file.

## To check by the owner, in a terminal

Run `claude --plugin-dir ./factory` in this repo and type `/factory`. Write here:

- [ ] The pane opens (docked or inline), and at what terminal width.
- [ ] No dim line that starts with `factory:` in the transcript.
- [ ] `factory/.claude-plugin/types/` exists after the load; then
      `npx -p typescript tsc -p factory` has no errors.
- [ ] The login type (personal, Team, Enterprise).

## Whole-plugin check by hand (plan Task 10, Step 6)

To do by the owner, in a scratch git repo with a GitHub remote:

- [ ] `claude --plugin-dir <this repo>/factory`, then `/factory init`. A file
      `.claude/factory.json` appears.
- [ ] `/factory` shows `SETTINGS NOT APPROVED` and the commands. `/factory approve`
      answers `Approved …`.
- [ ] TASK shows the branch (and the pull request, if the branch has one).
- [ ] Add `docs/plans/a/progress.md` with two checkboxes, one ticked. PROGRESS
      shows 50%.
- [ ] CHECKS shows `disk ok`. The status line shows a text.
- [ ] Add a line `BLOCKED: test` to the progress file and wait one minute. A
      toast appears, with a short sound.
