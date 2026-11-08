/** Normalizes GitHub issues, pull requests, comments, reviews, and CI transitions into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type ThreadRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'github'
/**
 * A repository name as GitHub spells it; a Thread ID is only meaningful together with the repository that hosts the
 * Issue or PR, because two repositories number their Issues independently.
 */
const REPOSITORY = '[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+'
/** Thread ID of an Issue or PR in `repository`; the Source appends it to its own name to make a Thread key. */
export const githubThreadId = (repository: string, number: number): string => `${repository}#${number}`
/** Thread ID of a repository's default-branch CI, which has no Issue or PR of its own. */
export const githubCiThreadId = (repository: string, branch: string): string => `${repository}#ci:${branch}`
/** The repository, Issue or PR number, or CI branch a Thread ID names. */
export interface GithubThreadName { repository: string; number?: number; branch?: string }
/** Parses a Thread ID back into its repository and Issue, PR, or CI branch; undefined for anything else. */
export function githubThreadName(id: string): GithubThreadName | undefined {
  const match = new RegExp(`^(${REPOSITORY})#(?:ci:(.+)|(\\d+))$`).exec(id)
  if (!match) return undefined
  return match[2] !== undefined ? { repository: match[1]!, branch: match[2] }
    : { repository: match[1]!, number: Number(match[3]) }
}
/** Parses a whole Thread key (`github:<repository>#<number>`), not just its ID. */
export const githubThreadKeyName = (key: string): GithubThreadName | undefined =>
  key.startsWith(`${SOURCE}:`) ? githubThreadName(key.slice(SOURCE.length + 1)) : undefined
/** The Thread an Issue or PR of `repository` is discussed on. */
export const githubThread = (repository: string, number: number): ThreadRef => ({ source: SOURCE, id: githubThreadId(repository, number) })
/** The Thread of `repository`'s default-branch CI. */
export const githubCiThread = (repository: string, branch: string): ThreadRef => ({ source: SOURCE, id: githubCiThreadId(repository, branch) })
/** GitHub reply address: issue/PR conversation in `repository`, or a review thread when `url` points at a discussion comment. */
export const githubChannel = (repository: string, number: number, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: `${SOURCE}:${githubThreadId(repository, number)}`,
    address: { repository, number: String(number), ...(url ? { url } : {}) } })
export const githubPage = (repository: string, number: number, pr = false): string =>
  `https://github.com/${repository}/${pr ? 'pull' : 'issues'}/${number}`
/**
 * Parses a web or API URL for an Issue, PR, or review comment in one of `repositories`, naming the configured
 * repository it belongs to; returns undefined for other URLs or repositories.
 */
export function githubAddress(url: string, repositories: readonly string[]):
{ repository: string; number: number; pr: boolean; discussion?: number } | undefined {
  const address = new RegExp(`^https:\\/\\/(?:api\\.github\\.com\\/repos|github\\.com)\\/(${REPOSITORY})\\/(issues|pulls?)\\/(\\d+)\\/?(?:#discussion_r(\\d+)|#[\\w-]*)?$`, 'i')
  const match = address.exec(url)
  if (!match) return undefined
  const repository = repositories.find(name => sameName(name, match[1]!))
  if (!repository) return undefined
  return { repository, number: Number(match[3]), pr: match[2]!.toLowerCase() !== 'issues', ...match[4] ? { discussion: Number(match[4]) } : {} }
}
/** GitHub returns a deleted account as `null` and displays it as `ghost`. */
export const UserSchema = z.looseObject({ login: z.string(), type: z.string().optional() }).nullable()
  .transform(user => user ?? { login: 'ghost', type: 'User' })
/**
 * A GitHub comment or review; a review carries `state` and `commit_id`, and an inline review comment carries its file,
 * line, diff hunk, and `in_reply_to_id` (the root comment ID of its review thread).
 */
export const CommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), user: UserSchema, html_url: z.string().nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), submitted_at: z.string().nullish(),
  state: z.string().nullish(), commit_id: z.string().nullish(),
  path: z.string().nullish(), line: z.number().nullish(), original_line: z.number().nullish(), diff_hunk: z.string().nullish(),
  in_reply_to_id: z.number().nullish(),
})
export type GithubComment = z.infer<typeof CommentSchema>
/** An Issue as `issues/<number>` returns it; GitHub sets `pull_request` when the number is a pull request. */
export const IssueSchema = CommentSchema.extend({
  number: z.number(), title: z.string(), state: z.string(), created_at: z.string(), html_url: z.string(),
  pull_request: z.looseObject({ url: z.string() }).nullish(),
})
export type GithubIssue = z.infer<typeof IssueSchema>
type Opened = Pick<GithubIssue, 'number' | 'title' | 'body' | 'user' | 'created_at' | 'html_url'>
/** An Issue or PR of a known repository, which is what its Thread, reply address, and reads are scoped by. */
export interface PullRef { repository: string; number: number; isPr: boolean; url?: string; prAuthor?: string }
/**
 * True when GitHub reports the account as a regular user rather than a bot or GitHub App.
 * Review bots running under ordinary user accounts count as human here; the prompts identify which accounts are automated.
 */
export const isHumanLogin = (user: { login: string; type?: string }): boolean =>
  !/\[bot\]$/.test(user.login) && (!user.type || user.type === 'User')
/** Formats an inline review comment's file:line and the trailing lines of its diff hunk, which GitHub ends at the commented line. */
export function reviewPlace(comment: GithubComment): string {
  const line = comment.line ?? comment.original_line
  const hunk = (comment.diff_hunk ?? '').split('\n').slice(-3).join('\n')
  return [`${comment.path}${line != null ? `:${line}` : ''}`, hunk].filter(Boolean).join('\n')
}
function commentText(comment: GithubComment, kind: 'conversation' | 'inline' | 'review'): string {
  const decided = kind === 'review' && comment.state && comment.state !== 'COMMENTED'
  const decision = decided ? `${comment.state} review of commit ${comment.commit_id ?? 'unknown'}` : ''
  const place = kind === 'inline' && comment.path ? reviewPlace(comment) : ''
  return [decision, place, comment.body ?? ''].filter(Boolean).join('\n\n')
}
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)
const author = (user: { login: string; type?: string }, agent: string) =>
  ({ actor: { source: SOURCE, id: user.login }, human: isHumanLogin(user) && !sameName(user.login, agent) })
/** Builds a trigger for a comment or review; text is empty for a bodyless comment or a `COMMENTED` review without a body. */
export function commentTrigger(comment: GithubComment, ref: PullRef, kind: 'conversation' | 'inline' | 'review', agent: string): Trigger {
  const at = comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? new Date().toISOString()
  const version = comment.updated_at ?? comment.submitted_at ?? ''
  const id = key('github-comment', comment.html_url ?? githubThreadId(ref.repository, ref.number), String(comment.id), version)
  return { id, source: SOURCE, threads: [githubThread(ref.repository, ref.number)], ...author(comment.user, agent), at,
    text: commentText(comment, kind),
    ...(mentions(comment.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(ref.repository, ref.number, comment.html_url ?? undefined),
    ...(comment.html_url ?? ref.url ? { url: comment.html_url ?? ref.url } : {}),
    meta: { number: ref.number, isPr: ref.isPr, ...(ref.prAuthor ? { prAuthor: ref.prAuthor } : {}), commentId: comment.id, kind,
      ...comment.path ? { path: comment.path, line: comment.line ?? comment.original_line ?? null } : {},
      ...comment.in_reply_to_id ? { inReplyTo: comment.in_reply_to_id } : {} } }
}
/**
 * Builds the trigger for a newly opened Issue's title and body.
 * The ID is the same as when Issue bodies were stored previously, so already-stored bodies are not ingested again.
 */
export function issueTrigger(issue: Opened, agent: string, repository: string): Trigger {
  const body = issue.body ?? ''
  return { id: key('github-issue', githubThreadId(repository, issue.number)), source: SOURCE,
    threads: [githubThread(repository, issue.number)], ...author(issue.user, agent), at: issue.created_at,
    text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(repository, issue.number, issue.html_url), url: issue.html_url,
    meta: { number: issue.number, repository, isPr: false, kind: 'issue' } }
}
/**
 * Builds the trigger for a newly opened PR's title and description.
 * PR and Issue numbers share one sequence in GitHub and never collide, so this reuses `issueTrigger`'s `github-issue` ID format.
 */
export function pullTrigger(pull: Opened, agent: string, repository: string): Trigger {
  return { ...issueTrigger(pull, agent, repository),
    meta: { number: pull.number, repository, isPr: true, prAuthor: pull.user.login, kind: 'pull' } }
}
/** Builds a trigger for a default-branch CI transition; default-branch CI has no person to reply to, so it has no `channel`. */
export function branchCiTrigger(repository: string, branch: string, sha: string, revision: number, summary: string, url: string): Trigger {
  return { id: key('github-ci', `${repository}#branch:${branch}`, String(revision)), source: SOURCE,
    threads: [githubCiThread(repository, branch)], actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, url, meta: { ci: true, repository, branch, sha, revision } }
}
export function ciTrigger(repository: string, pr: { number: number; html_url: string; user: { login: string } }, revision: number, summary: string): Trigger {
  return { id: key('github-ci', githubThreadId(repository, pr.number), String(revision)), source: SOURCE,
    threads: [githubThread(repository, pr.number)],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, channel: githubChannel(repository, pr.number), url: pr.html_url,
    meta: { number: pr.number, repository, isPr: true, prAuthor: pr.user.login, ci: true, revision } }
}
