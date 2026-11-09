/** Workspace prepare rendering: one clone per repository, idempotent re-runs, and worktrees bound to their own remote. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLONE_ROOT, cloneDirectory, prepareCommand, prepareScript } from '../src/executor/prepare.ts'

/** Runs git in `cwd` with a test identity, returning its trimmed stdout. */
const git = (cwd: string, ...args: string[]): string => execFileSync('git',
  ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** Creates a bare repository for `repository` holding one commit on `main`, and returns its path. */
const remote = (root: string, repository: string): string => {
  const path = join(root, `${repository}.git`)
  mkdirSync(path, { recursive: true })
  git(path, 'init', '--bare')
  const seed = mkdtempSync(join(tmpdir(), 'dsh-seed-'))
  git(seed, 'init')
  writeFileSync(join(seed, 'README.md'), `# ${repository}\n`)
  git(seed, 'add', 'README.md')
  git(seed, 'commit', '-m', `init ${repository}`)
  git(seed, 'push', path, 'HEAD:refs/heads/main')
  git(path, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  return path
}

/** A temporary workspace with its own remotes, clones and worktree roots, so no test touches the real ones. */
const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-prepare-'))
  const remotes = join(root, 'remotes'), clones = join(root, 'clones'), work = join(root, 'work')
  for (const path of [remotes, clones, work]) mkdirSync(path)
  return { remotes, clones, work }
}

/** Runs a rendered prepare command with the ticket's execution environment. */
const run = (script: string, env: Record<string, string>): string => execFileSync('sh', ['-c', script],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DSH_SUPERAGENT_GITHUB_PR_HEAD: '', ...env } })

describe('workspace prepare', () => {
  it('names one clone per repository and addresses that repository', () => {
    expect(cloneDirectory('alen-bot001/test_task')).toBe(`${CLONE_ROOT}/alen-bot001__test_task`)
    expect(cloneDirectory('Berlain/test')).toBe(`${CLONE_ROOT}/Berlain__test`)
    expect(prepareCommand('alen-bot001/test_task')).toContain(`'${CLONE_ROOT}/alen-bot001__test_task'`)
    expect(prepareCommand('alen-bot001/test_task')).toContain(`'https://github.com/alen-bot001/test_task.git'`)
    expect(prepareCommand('Berlain/test')).toContain(`'${CLONE_ROOT}/Berlain__test'`)
    expect(prepareCommand('Berlain/test')).toContain(`'https://github.com/Berlain/test.git'`)
    expect(prepareScript()).toContain(`root='${CLONE_ROOT}'`)
    expect(prepareScript()).toContain(`sed 's|/|__|g'`)
    expect(prepareScript()).toContain('$DSH_SUPERAGENT_GITHUB_REPOSITORY')
  })

  it('clones each repository once and binds every worktree to its own remote', () => {
    const { remotes, clones, work } = workspace()
    remote(remotes, 'alen-bot001/test_task')
    remote(remotes, 'Berlain/test')
    const base = `file://${remotes}`
    const prepare = (repository: string, ticket: string, name: string): void => {
      run(prepareCommand(repository, { root: clones, base, proxy: '' }),
        { DSH_SUPERAGENT_DIR: join(work, name), DSH_SUPERAGENT_NAME: name, DSH_SUPERAGENT_TICKET: ticket })
    }
    prepare('alen-bot001/test_task', 'a09e8f9371a9', 'improve-readme-a09e8f9371a9')
    prepare('Berlain/test', '5146637fe535', 'upload-test-code-5146637fe535')
    expect(readdirSync(clones).sort()).toEqual(['Berlain__test', 'alen-bot001__test_task'])
    expect(git(join(work, 'improve-readme-a09e8f9371a9'), 'remote', 'get-url', 'origin'))
      .toBe(`${base}/alen-bot001/test_task.git`)
    expect(git(join(work, 'upload-test-code-5146637fe535'), 'remote', 'get-url', 'origin'))
      .toBe(`${base}/Berlain/test.git`)
    expect(git(join(work, 'upload-test-code-5146637fe535'), 'remote', 'get-url', '--push', 'origin'))
      .toBe(`${base}/Berlain/test.git`)
  })

  it('re-runs idempotently and reuses the repository clone for another ticket', () => {
    const { remotes, clones, work } = workspace()
    remote(remotes, 'Berlain/test')
    const base = `file://${remotes}`
    const prepare = (ticket: string, name: string): void => {
      run(prepareCommand('Berlain/test', { root: clones, base, proxy: '' }),
        { DSH_SUPERAGENT_DIR: join(work, name), DSH_SUPERAGENT_NAME: name, DSH_SUPERAGENT_TICKET: ticket })
    }
    prepare('5146637fe535', 'upload-test-code-5146637fe535')
    const head = git(join(work, 'upload-test-code-5146637fe535'), 'rev-parse', 'HEAD')
    writeFileSync(join(clones, 'Berlain__test', 'marker'), 'cloned once')
    prepare('5146637fe535', 'upload-test-code-5146637fe535')
    expect(existsSync(join(clones, 'Berlain__test', 'marker'))).toBe(true)
    expect(git(join(work, 'upload-test-code-5146637fe535'), 'rev-parse', 'HEAD')).toBe(head)
    prepare('97b066efba89', 'add-more-test-code-97b066efba89')
    expect(readdirSync(clones)).toEqual(['Berlain__test'])
    expect(git(join(work, 'add-more-test-code-97b066efba89'), 'remote', 'get-url', 'origin'))
      .toBe(`${base}/Berlain/test.git`)
    expect(git(join(clones, 'Berlain__test'), 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')))
      .toHaveLength(3)
  })

  it('the configured command clones into the directory its repository names', () => {
    const { remotes, clones, work } = workspace()
    remote(remotes, 'Berlain/test')
    run(prepareScript({ root: clones, base: `file://${remotes}`, proxy: '' }), {
      DSH_SUPERAGENT_GITHUB_REPOSITORY: 'Berlain/test', DSH_SUPERAGENT_DIR: join(work, 't'),
      DSH_SUPERAGENT_NAME: 't', DSH_SUPERAGENT_TICKET: 't1',
    })
    expect(existsSync(join(clones, 'Berlain__test', '.git'))).toBe(true)
    expect(git(join(work, 't'), 'remote', 'get-url', 'origin')).toBe(`file://${remotes}/Berlain/test.git`)
  })
})
