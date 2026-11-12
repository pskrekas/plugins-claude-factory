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
