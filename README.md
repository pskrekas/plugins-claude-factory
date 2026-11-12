# Factory

**A Claude Code plugin that shows the state of your work in a docked panel, and (in a later version) runs a software factory.**

The panel answers four questions without a prompt: what is my task, how far is each build, what waits for me, and is my environment correct. It knows no project: a repo tells it what to show through one settings file, `.claude/factory.json`.

This is an early version. It has the panel only. The factory line (a marked tracker item goes through Intake, Spec, Build, Gate, Review and Approve, and comes out as a ready pull request that a person merges) is the next phase. The design is in [`docs/superpowers/specs`](docs/superpowers/specs).

## Install

Inside Claude Code (2.1.322 or later):

```
/plugin marketplace add pskrekas/plugins-claude-factory
/plugin install factory@plugins-claude-factory
/reload-plugins
/factory
```

Or load it from a clone, for one session:

```sh
git clone https://github.com/pskrekas/plugins-claude-factory
claude --plugin-dir ./plugins-claude-factory/factory
```

Mods are an early-access Claude Code feature and their API can change between releases.

## Use

| Command | Does |
| --- | --- |
| `/factory` | opens the pane |
| `/factory close` | closes it |

## Develop

```sh
claude --plugin-dir ./factory     # load it; edits hot-reload
claude plugin validate factory
claude plugin test factory
npx -p typescript tsc -p factory  # after the first load, which writes factory/.claude-plugin/types/
```

## License

MIT
