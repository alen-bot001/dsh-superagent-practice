/**
 * Workspace prepare command: one clone per watched repository, so every ticket's worktree shares its remote with its own
 * repository instead of with whichever repository was cloned first.
 *
 * A single clone cannot serve two repositories: worktrees inherit the clone's `remote.origin`, so a `git push origin` (or a
 * bare `git push` once an upstream exists) from a ticket on the second repository would push to the first one. The command
 * rendered here keeps one clone per `owner/name` under `CLONE_ROOT`, named `owner__name` so it stays one path segment,
 * clones it on first use, fetches the ticket's ref from that repository, and adds the ticket's worktree from that clone.
 * Re-running it for a prepared workspace re-fetches and leaves the existing worktree alone.
 */

/** Root directory holding one clone per watched repository. */
export const CLONE_ROOT = '/home/admin/Documents/src'
/** Repository host that clones and fetches address. */
export const GITHUB = 'https://github.com'
/** HTTP proxy github.com needs on this host, applied per git invocation because worker git config carries no proxy. */
export const PROXY = 'http://127.0.0.1:7897'

/** Single-quotes `value` for the POSIX shell. */
const quote = (value: string): string => `'${value.split("'").join(`'\\''`)}'`

/** Directory of `repository`'s own clone: `owner/name` becomes `owner__name`, so it stays one path segment. */
export const cloneDirectory = (repository: string, root: string = CLONE_ROOT): string => `${root}/${repository.split('/').join('__')}`

/**
 * Renders the three prepare steps for a clone at `directory` addressed by `url`, with `directory`, `url` and `proxy`
 * already single-quoted for the shell: clone on first use, fetch the Ticket's ref, then add the Ticket's worktree from
 * that clone. Each step fails the command outright, so a Ticket never starts in a half-prepared workspace, and an
 * existing clone or worktree is left alone. An empty `proxy` leaves `http.proxy` unset.
 */
const steps = (directory: string, url: string, proxy: string): string => {
  const config = proxy ? ` -c http.proxy=${proxy}` : ''
  return [
    `if [ ! -e ${directory}/.git ]; then git${config} clone --no-checkout ${url} ${directory} || exit 1; fi`,
    `git -C ${directory}${config} fetch --no-tags ${url} "\${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/\${DSH_SUPERAGENT_TICKET}" || exit 1`,
    `if [ ! -e "$DSH_SUPERAGENT_DIR/.git" ]; then git -C ${directory} worktree add -b "agent/\${DSH_SUPERAGENT_NAME}" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/\${DSH_SUPERAGENT_TICKET}" || exit 1; fi`,
  ].join('\n')
}

/** Optional rendering inputs; each defaults to this host's value. */
export interface PrepareOptions {
  /** Root directory holding one clone per repository. */
  root?: string
  /** Repository host, such as `https://github.com`, or a `file://` base in tests. */
  base?: string
  /** HTTP proxy for git, or empty to leave `http.proxy` unset. */
  proxy?: string
}

/** Renders the prepare command for one `repository`, as a deployment that prepares only that repository would store it. */
export const prepareCommand = (repository: string, options: PrepareOptions = {}): string => {
  const { root = CLONE_ROOT, base = GITHUB, proxy = PROXY } = options
  return steps(quote(cloneDirectory(repository, root)), quote(`${base}/${repository}.git`), proxy ? quote(proxy) : '')
}

/**
 * Renders the prepare command a deployment configures once for every ticket: it reads `DSH_SUPERAGENT_GITHUB_REPOSITORY`
 * to pick that repository's clone, so one command serves every watched repository without sharing a remote between them.
 */
export const prepareScript = (options: PrepareOptions = {}): string => {
  const { root = CLONE_ROOT, base = GITHUB, proxy = PROXY } = options
  return [
    `root=${quote(root)}`,
    `base=${quote(base)}`,
    `proxy=${quote(proxy)}`,
    'repo="$DSH_SUPERAGENT_GITHUB_REPOSITORY"',
    `dir="$root/$(printf '%s' "$repo" | sed 's|/|__|g')"`,
    steps('"$dir"', '"$base/$repo.git"', proxy ? '"$proxy"' : ''),
  ].join('\n')
}
