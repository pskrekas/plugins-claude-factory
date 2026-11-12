import { expect, test } from 'claude-code/testing'

import { fenceOf } from '../core/fence'
import type { Who } from '../core/fence'

const WT = '/s/worktrees/12-a'
const JOB = '/s/jobs/12-a'
const who: Who = { role: 'builder', worktree: WT, jobDir: JOB, outFile: `${JOB}/out/build.md`, forbiddenCommands: [['npm', 'publish'], ['terraform', 'apply']] }
const reviewer: Who = { ...who, role: 'reviewer', outFile: `${JOB}/out/review-code.md` }
const bash = (command: string) => fenceOf({ tool: 'Bash', input: { command } }, who)
const ALLOW = { decision: 'allow' }

test('ordinary work of the builder is allowed', async () => {
  for (const ok of ['npm test', 'npm install && npm run lint', 'git status', 'git add -A && git commit -m "Add the page"', 'git diff HEAD~1', 'git log --oneline | head -5',
    'git commit -m "push to main"', 'git checkout -b try', 'ls -la; cat package.json', 'python3 -m pytest -q', 'mkdir -p src/new && touch src/new/a.ts', 'grep -rn "gh " docs'])
    expect([ok, bash(ok)]).toEqual([ok, ALLOW])
})

test('the builder cannot push, merge on the host, or change git settings', async () => {
  const bad = [
    'git push origin main', 'cd x && git push', 'true; sudo git push -f', 'FOO=1 /usr/bin/git push', 'echo $(git config user.name x)',
    'git push', 'git  push   origin HEAD', 'npm test || git push', 'npm test | git push', 'echo `git push`', '(git push)', 'git\tpush',
    'git config core.hooksPath /tmp/x', 'git replace a b', 'git update-ref refs/heads/main HEAD', 'git remote add evil http://example.com/x', 'git worktree add ../x',
    'git symbolic-ref HEAD refs/heads/main', 'git -c core.fsmonitor=/tmp/x status', 'git -C /somewhere status', 'git --git-dir=/x/.git log', 'git --work-tree /x status',
    'git branch origin/main HEAD', 'git tag refs/x', 'git checkout -b origin/main', 'git switch -c refs/remotes/origin/main',
    'gh pr merge 3', 'gh api repos/a/b/pulls/3/merge -X PUT', '/opt/homebrew/bin/gh pr create', 'az repos pr update --id 3 --status completed',
    'bash -c "git push origin main"', 'sh -c \'gh pr merge 3\'', 'eval "git push"', 'env GIT_DIR=/x git push', 'command git push', 'nohup git push &',
  ]
  for (const command of bad) expect([command, bash(command)?.decision]).toEqual([command, 'deny'])
  expect(bash('git push origin main')).toEqual({ decision: 'deny', reason: 'The line pushes; an agent does not.', command: 'git push origin main' })
  expect(bash('npm test && gh pr merge 3')).toEqual({ decision: 'deny', reason: 'The line talks to the host; an agent does not.', command: 'gh pr merge 3' })
})

test('ways around the words are refused too', async () => {
  const bad = [
    // Git told where to look through the environment.
    'GIT_DIR=/x/.git git status', 'env GIT_WORK_TREE=/x git status', 'export GIT_CONFIG_GLOBAL=/tmp/x', 'GIT_SSH_COMMAND="sh -c x" git fetch',
    // A shell with its flags joined, and a nest too deep to follow.
    'bash -lc "git push"', 'sh -ec "gh pr merge 3"', 'bash -c "bash -c \'bash -c \\"git push\\"\'"',
    // The lower-level ways to send commits.
    'git send-pack origin HEAD', 'git http-push http://example.com/x',
    // A program name or a git command that is spelled with quotes, a backslash or a variable.
    'g\\it push', 'gi""t push', '$GIT push', 'git pu""sh', 'git $CMD origin',
    // A program or a git command that the shell would fill in, and git's helper programs.
    'gi? push', '/usr/bin/gi[t] push', 'git pus? origin', 'git {push,status}', '~/bin/git push', 'git-receive-pack x', '/usr/libexec/git-core/git-push origin',
    // A git variable named in any way.
    'export "GIT_DIR"=/x', 'declare -x GIT_DIR=/x', 'read GIT_DIR < f', 'printf -v GIT_WORK_TREE /x', 'X=GIT_DIR; eval "$X=/x"',
    // The git folder by another spelling, or by a pattern.
    'cd .GIT', 'cd .Git/hooks', 'cd .gi?', 'cd .g*', 'echo x > .GIT/config', 'rm -rf ./.Git',
    // The git folder as a pattern, in a write.
    'rm -rf .gi?', 'echo x > .g*/config', 'cp evil .[g]it/hooks/pre-commit', 'mv x .{git}/config', 'rm -rf .*', 'cd [.]git',
    // A variable whose name is built from pieces.
    'export "$A$B"=/x', 'declare -x "GI""T_DIR"=/x', 'read -r "$NAME" < f', 'printf -v "$NAME" /x', 'export {A,B}=1',
    // The git folder spelled with quotes, a backslash or a variable.
    'cd .g""it', 'cd .gi\\t', 'cd "$X"', 'pushd ~/x', 'rm -rf .g""it', 'echo x > ".git"/config', "cp evil '.git'/hooks/x", 'mv x .gi\\t/config',
    // The shell's own ways to be in another folder than the one it shows.
    'CDPATH=.git cd hooks', 'export CDPATH=/x', 'cd -', 'cd', 'popd', 'cd "$OLDPWD"', 'HOME=/x/.config cd', 'PWD=/x ls',
    // A write to a place that only the shell knows.
    'echo x > "$TARGET"', 'cp evil ~/x', 'rm -rf $DIR', 'tee "$F" < x', 'mv a "${B}"',
    // Into the git folder, then a write with no path.
    'cd .git && echo x > config', 'cd ./.git/hooks; cp /tmp/x pre-commit', `cd ${WT}/.git`, 'pushd .git',
  ]
  for (const command of bad) expect([command, bash(command)?.decision]).toEqual([command, 'deny'])
  expect(bash('GIT_DIR=/x/.git git status')).toEqual({ decision: 'deny', reason: "Git settings and refs are not an agent's to change.", command: 'GIT_DIR=/x/.git git status' })
  // Ordinary variables and folders are still fine.
  for (const ok of ['NODE_ENV=test npm test', 'CI=1 npm run build', 'cd src && npm test', 'cd .github && ls', 'bash -c "npm test"', 'bash scripts/build.sh',
    'rm -rf dist/*', 'cp src/*.ts out/', 'export NODE_ENV=test', 'ls .github/*.yml', 'printf "%s" x', 'echo "$PATH"', 'npm test -- --dir="$PWD"', 'echo done > out.txt'])
    expect([ok, bash(ok)]).toEqual([ok, ALLOW])
})

test("a repo's forbidden commands are refused, with or without what follows them", async () => {
  for (const command of ['npm publish', 'npm publish --tag next', 'cd pkg && npm publish', './node_modules/.bin/terraform apply -auto-approve', 'terraform  apply'])
    expect([command, bash(command)?.decision]).toEqual([command, 'deny'])
  expect(bash('npm publish --tag next')).toEqual({ decision: 'deny', reason: 'This command is forbidden in this repository.', command: 'npm publish --tag next' })
  expect(bash('npm run publish-docs')).toEqual(ALLOW)
  expect(bash('terraform plan')).toEqual(ALLOW)
})

test('the git folder is not written to', async () => {
  for (const command of ['echo x > .git/config', `rm -rf ${WT}/.git`, 'rm .git', 'mv .git .git2', 'cp evil .git/hooks/pre-commit', 'ln -s /x .git/hooks', 'echo x | tee .git/info/exclude', "sed -i '' s/a/b/ .git/config", 'chmod +x .git/hooks/x'])
    expect([command, bash(command)?.decision]).toEqual([command, 'deny'])
  // The git folder is not named at all, also not to read it: git's own commands say what is in it.
  for (const command of ['cat .git/HEAD', 'ls .git', 'tar cf x.tar --directory=.git .', 'env -C .git ls', 'builtin cd .git', 'find . -path ./.git/hooks'])
    expect([command, bash(command)?.decision]).toEqual([command, 'deny'])
  expect(bash('ls .github')).toEqual(ALLOW)
  expect(bash('echo node_modules >> .gitignore')).toEqual(ALLOW)
})

test('a file is read only inside the job: its worktree and its folder', async () => {
  const read = (file_path: string, as = who) => fenceOf({ tool: 'Read', input: { file_path } }, as)
  expect(read(`${WT}/src/a.ts`)).toEqual(ALLOW)
  expect(read('src/a.ts')).toEqual(ALLOW)
  expect(read(`${JOB}/files/item.md`, reviewer)).toEqual(ALLOW)
  for (const path of [`${WT}/../13-b/x`, '/etc/passwd', '/r/.env', '../../jobs/13-b/files/item.md', '~/.ssh/id_rsa', `${WT}-other/x`, '/s/jobs'])
    expect([path, read(path)?.decision]).toEqual([path, 'deny'])
  expect(read('/etc/passwd')).toEqual({ decision: 'deny', reason: 'This is outside the job.', command: '/etc/passwd' })
  expect(fenceOf({ tool: 'Grep', input: { pattern: 'x' } }, reviewer)).toEqual(ALLOW)
  expect(fenceOf({ tool: 'Grep', input: { pattern: 'x', path: '/r' } }, reviewer)?.decision).toBe('deny')
  expect(fenceOf({ tool: 'Glob', input: { pattern: '**/*.ts' } }, reviewer)).toEqual(ALLOW)
  expect(fenceOf({ tool: 'Glob', input: { pattern: '/etc/**' } }, reviewer)?.decision).toBe('deny')
  expect(fenceOf({ tool: 'Glob', input: { pattern: '../**/*.md' } }, reviewer)?.decision).toBe('deny')
  expect(fenceOf({ tool: 'Glob', input: { pattern: `${JOB}/files/**` } }, reviewer)).toEqual(ALLOW)
  // A wildcard in the name of the job's own folder could match its neighbours.
  expect(fenceOf({ tool: 'Glob', input: { pattern: `${WT}*/secret` } }, reviewer)?.decision).toBe('deny')
  expect(fenceOf({ tool: 'Glob', input: { pattern: '/s/jobs/1?-a/files/item.md' } }, reviewer)?.decision).toBe('deny')
  expect(fenceOf({ tool: 'Glob', input: { pattern: `${WT}/src/*.ts` } }, reviewer)).toEqual(ALLOW)
  // A group of choices can hold a path of its own, and two dots can hide in a name.
  for (const pattern of ['{/etc,src}/**', 'src/{a,../../../x}/*', `${WT}/{src,/etc}/x`, 'src/..x/../**', '**/..'])
    expect([pattern, fenceOf({ tool: 'Glob', input: { pattern } }, reviewer)?.decision]).toEqual([pattern, 'deny'])
})

test('a file is written only where the role writes', async () => {
  const write = (file_path: string, as = who, tool = 'Write') => fenceOf({ tool, input: { file_path, content: 'x' } }, as)
  expect(write(`${WT}/src/a.ts`)).toEqual(ALLOW)
  expect(write('src/a.ts', who, 'Edit')).toEqual(ALLOW)
  expect(write(`${JOB}/out/build.md`)).toEqual(ALLOW)
  expect(write(`${JOB}/out/review-code.md`, reviewer)).toEqual(ALLOW)
  // Outside the code, an agent writes its one file and no other, also not next to it.
  expect(write(`${JOB}/out/review-security.md`, reviewer)?.decision).toBe('deny')
  expect(write(`${JOB}/out/decision.md`, reviewer)?.decision).toBe('deny')
  expect(write(`${JOB}/out/other.md`)?.decision).toBe('deny')
  expect(write(`${JOB}/out/sub/../review-code.md`, reviewer)).toEqual(ALLOW)
  // The job's own files are the plugin's, not an agent's.
  expect(write(`${JOB}/files/spec.md`)?.decision).toBe('deny')
  expect(write(`${JOB}/job.json`)?.decision).toBe('deny')
  expect(write(`${WT}/x`, reviewer)?.decision).toBe('deny')
  expect(write('notes.md', reviewer)?.decision).toBe('deny')
  expect(write(`${WT}/.git`)?.decision).toBe('deny')
  expect(write(`${WT}/.git/config`)?.decision).toBe('deny')
  expect(write(`${WT}/sub/../.git/hooks/x`, who, 'Edit')?.decision).toBe('deny')
  expect(write(`${JOB}/out/../job.json`)?.decision).toBe('deny')
  expect(write(`${JOB}/files/spec.md`)).toEqual({ decision: 'deny', reason: 'This is not a place this agent writes.', command: `${JOB}/files/spec.md` })
})

test('the fence answers only for the tools of the role, and only for what it understands', async () => {
  expect(fenceOf({ tool: 'SubagentHandback', input: {} }, who)).toBe(null)
  expect(fenceOf({ tool: 'Agent', input: {} }, who)).toBe(null)
  expect(fenceOf({ tool: 'WebFetch', input: { url: 'https://example.com' } }, who)).toBe(null)
  expect(fenceOf({ tool: 'Bash', input: { command: 'ls' } }, { ...who, role: 'spec' })).toBe(null)
  expect(fenceOf({ tool: 'Edit', input: { file_path: `${JOB}/out/review-code.md` } }, reviewer)).toBe(null)
  for (const input of [null, 'ls', {}, { command: 5 }, { command: '' }]) expect(fenceOf({ tool: 'Bash', input }, who)?.decision).toBe('deny')
  expect(fenceOf({ tool: 'Write', input: {} }, who)).toEqual({ decision: 'deny', reason: 'The call was not understood.', command: '' })
  // A long command is cut in what is kept of it, and cleaned.
  const long = bash('git push ' + 'x'.repeat(500) + '\u001b[2J')
  expect([long?.decision, long && 'command' in long ? long.command.length : 0]).toEqual(['deny', 200])
})
