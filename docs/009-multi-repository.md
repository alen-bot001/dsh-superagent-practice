# 009 Multi-repository support

One dsh-superagent deployment can watch several GitHub repositories. This document explains the design behind that support and where each part is implemented. It builds on [001 Domain model](001-domain.md), [003 Execution](003-execution.md), [006 Deployment](006-deployment.md) and [007 Architecture](007-architecture.md).

## Why one deployment

The GitHub Source acts as one agent account. GitHub's notifications endpoint is account-wide, and a repository is only a filter over it; the account also owns one set of Issues, pull requests and CI reads. Running one deployment per repository would either need one agent account per repository, or split the account's notifications, the Policy's allowed list, the work queue and the panel across deployments.

One Source instance therefore watches a list of repositories. The cost is that every place that used to say "the repository" must now say which repository it means. The design keeps that fact in one place, the Thread ID, and derives every other repository-qualified key from it.

## Invariants

These rules hold for every read, write and migration:

- **A Thread belongs to exactly one repository.** An Issue or pull request number is only unique inside its repository, so the repository is part of the Thread rather than an attribute looked up later.
- **Every repository-qualified record names one repository.** Read positions, CI fingerprints, retries, replies and workspace clones are keyed by the Thread or repository they belong to.
- **One repository never advances another repository's position.** A read of `owner/name#12` cannot move the cursor, retry or CI revision of another repository's `#12`.
- **One repository's failure does not hide another repository's events.** Repository-wide streams and CI are polled per repository and fail independently.
- **A workspace belongs to the Ticket's repository.** The prepare command clones one repository, chosen from the Ticket's Thread, and a worktree keeps that clone's remote.
- **A migration never guesses.** A database written before Thread IDs named a repository is migrated only when its records name one repository; an ambiguous database is refused with its file unchanged.
- **The deployment stays one.** One agent account, one Policy, one effect queue and one panel serve all watched repositories.

## Configuration

The GitHub Source's configuration is defined by `GithubAccountsSchema` in [`src/deployment.ts`](../src/deployment.ts).

| Field | Meaning |
| --- | --- |
| `repositories` | The watched repositories, one `{ "name": "owner/name" }` row each, at most 20 (`MAX_REPOSITORIES`) |
| `repository` | Deprecated: the single repository of a configuration written before a Source could watch several |
| `cli` | The agent's `gh` wrapper, signed in to the account the Source acts as |

`watchedRepositories(accounts)` is the one reader of the configuration:

- When `repositories` has rows, they are the watch list.
- Otherwise the deprecated `repository` value is split on whitespace or commas, so a hand-written configuration written before rows existed keeps working.
- Names are deduplicated case-insensitively, preserving the first spelling and the configured order.

`repositoryRows(accounts)` projects the same value into the rows the panel edits. A configuration that still names one repository in the deprecated field shows that repository as a row, so it can be edited or removed; saving stores `repositories` and clears `repository`.

Setup resolves the rows through `resolveDeployment`:

1. The agent CLI is checked and its account is read.
2. For every row, `gh api repos/<owner>/<name>` supplies GitHub's canonical `full_name` and the account's push permission.
3. Every repository must be readable and pushable. Setup fails with `repositoryUnreadable` or `repositoryReadOnly` rather than silently watching fewer repositories than configured.
4. Canonical names are deduplicated, so a notification that arrives under a renamed repository still matches the configured one.

The panel's field is a rows editor, and saving it is a setup-read change: `Settings` runs the account check and restarts dsh-superagent. The setup comparison uses the parsed configuration, not the raw rows, so the default-filled `repositories` field does not look changed on every save. `primaryRepository(deployment)` returns the first resolved repository and is only a fallback for work with no repository of its own, such as a reply queued before the Source could watch several repositories.

`SETUP.md` asks for one to twenty repositories; [006 Deployment](006-deployment.md) describes the operator's side, including the per-repository push check.

## Thread identity

### IDs and keys

A GitHub Thread names its repository first; the Source then prefixes its own name to make the Thread key.

| Kind | Thread ID | Thread key |
| --- | --- | --- |
| Issue or pull request | `owner/name#12` | `github:owner/name#12` |
| Default-branch CI | `owner/name#ci:main` | `github:owner/name#ci:main` |

`githubThreadId` and `githubCiThreadId` in [`src/sources/github-trigger.ts`](../src/sources/github-trigger.ts) build the ID. `githubThreadName` parses it back into `{ repository, number }` or `{ repository, branch }`. The repository path uses GitHub's spelling; comparison is case-insensitive through `sameName`, while the canonical configured spelling is what gets stored.

The same parser still accepts an ID written before IDs named a repository (`12`, `ci:main`), with an empty repository. Such an ID only means something while the deployment watches exactly one repository: `threadRepository(named, repositories)` returns that repository, and with several repositories it returns `undefined` rather than guess. Callers that meet an unresolved ID either skip it or report it, as `pollThread` does with `Subscribed thread … names no repository`.

The schema 12 migration rewrites the old form to the qualified form, so an upgraded database has no bare GitHub Thread ID left. The legacy parser remains for an unmigrated record or a hand-written test.

### Addresses, replies and pages

`githubAddress(url, repositories)` maps an Issue, pull request or review-comment URL back to the configured repository. It accepts `api.github.com/repos/...` and `github.com/...` addresses, matches the repository case-insensitively, and returns `undefined` for a repository outside the watch list or for a URL that points at a discussion rather than an Issue or pull request. The notification poll uses it to drop anything the deployment does not watch, and counts the drop in its health detail.

`githubChannel(repository, number, url)` puts the repository and number in the reply address, so a reply to `owner/name#12` is posted to that repository. `githubPage(repository, number)` builds the web link from the same pair. Replies and links use the repository in the addressed Channel; only a legacy address that carries no repository falls back to the first configured one.

### Ticket environment and pull requests

The GitHub Source registers `DSH_SUPERAGENT_GITHUB_REPOSITORY` as an execution variable ([003 Execution](003-execution.md)). Its value comes from the repository named by the Ticket's originating Trigger; a Ticket that did not originate on GitHub falls back to the first configured repository. The prepare command reads this variable to choose its clone, so one stored command serves every watched repository.

A Ticket's followed pull requests are Threads too. `pullsOf(ticket, own)` and `pollTicketPulls` parse each followed Thread's repository and read the pull request in that repository. A pull request opened in `owner/name` is never looked up in another repository's namespace.

### Search

`find` accepts `owner/name#12` or a GitHub page URL and returns that Thread when the repository is watched. A bare `#12` names the Issue with that number in every watched repository, because the number alone is ambiguous. A deployment that knows no watched repository refuses the bare form and tells the caller to write `owner/name#12`.

### State keys

Everything a poll stores is keyed by the part it belongs to. The entries are declared in [`src/kv.ts`](../src/kv.ts).

| Record | Key | Scope |
| --- | --- | --- |
| Notification cursor | `github-since` | Account |
| Processed notifications | `github-notices` | Account; notification ID to the round that read it |
| Pending notification retries | `github-retry` | Account map; Thread ID |
| Issue or pull request read position | `github-cursor:<owner/name>#<number>` | Thread |
| Pull-request CI fingerprint | `github-ci:<owner/name>#<number>` | Thread |
| Repository stream position | `github-stream:<owner/name>:<stream>` | Repository and stream |
| Default-branch CI baseline | `github-branch-ci:<owner/name>` | Repository |

The notification cursor is the exception that stays account-wide, because notifications are an account-level list. The next sections explain why that exception is safe.

## Ingestion

### Notifications

Notifications are the main way a request reaches the agent. GitHub's `/notifications` list belongs to the account, but the command wrapper can only call paths inside one repository, so the Source lists `notifications` once per watched repository and merges the results. The account-wide `github-since` cursor is advanced once per notification round.

A cursor alone is not enough. GitHub can publish a notification several seconds after the event's `updated_at`, so a cursor taken from the previous round can already be past the notification; reading by cursor alone would lose it. The poll therefore:

1. Lists each repository's notifications from a window that reaches back `lookbackSeconds` (60 to 3600, default 900) before the round, or from `github-since` when that is older.
2. Keeps a processed-notification ledger, `github-notices`, mapping each notification ID to the round that read it. A listed notification is skipped when its ID is already in the ledger and it has no pending retry.
3. Reads each new notification's Issue or pull request from the notification's own repository. The read starts at the earlier of the Thread's cursor and the notification's `updated_at`, so a comment that trails the notification is still seen.
4. Treats an Issue opened within `NOTICE_LAG_MS` (15 minutes) of the read position as new even when its `created_at` is slightly older, so a late notification still delivers the Issue body. A mention added by a later edit is not read as the body's actor.
5. Advances `github-since` to five seconds before the round, saves the pending retries and prunes the ledger, all in one transaction.

A failed read becomes a retry keyed by its Thread ID and is tried first on the next round. A deleted Issue or pull request (HTTP 410) is dropped after the error is recorded; HTTP 404 is retried because it can mean temporary loss of access to a private repository. A retry that keeps failing for 24 hours is abandoned so it cannot hold the Source in an error state, while its cursor stays for a later notification or Thread poll. The ledger keeps entries for 30 days and at most 5000 IDs; after a long pause a pruned notification can be listed again, and the deterministic Trigger ID deduplicates it.

Health detail counts the notifications listed, the ones outside the watch list, the ones already processed and the unreadable ones. A drop is visible instead of silent.

A failure while listing one repository's notifications fails the notification step for the round; the repository streams, Ticket pull requests and subscribed Threads still run, and the next round's lookback window lists the unread repositories again.

### Repository-wide streams

When observation is switched on, the Source reads three repository-wide streams for every watched repository:

| Stream | Endpoint | What it reads |
| --- | --- | --- |
| Issues | `issues` | New Issues and pull requests |
| Conversation comments | `issues/comments` | Comments on Issues and pull requests |
| Review comments | `pulls/comments` | Inline review comments |

Each `(repository, stream)` pair has its own cursor and start times in `github-stream:<owner/name>:<stream>`. The source reads oldest first, keeps an ETag for an unchanged page, and ignores items older than the two-week poll horizon or older than the moment the kind was switched on. A failure in one repository's stream is recorded in the round's failures and does not stop the other streams or repositories.

Default-branch CI is also per repository. `github-branch-ci:<owner/name>` holds the baseline of failing checks, the branch and a revision counter. The first observation establishes the baseline; a change in the failing set produces one trigger, and the revision keeps every trigger ID distinct. Turning CI observation off clears the failure baseline but preserves the revision.

### Pull requests and subscribed Threads

After the repository streams, the Source polls the pull requests of open Tickets and of subscribed Threads. It reads each pull request once per round, keyed by Thread ID, so two repositories' `#1` are two reads and never overwrite each other. Pull-request CI is keyed by the Thread too (`github-ci:<owner/name>#<number>`), so a revision in one repository does not restart the other's CI baseline.

A subscribed Thread is read in the repository its ID names. A Thread keyed by a bare number before schema 12 has no repository when several are watched; the Source reports that instead of reading the wrong repository.

### Round order and health

One polling round runs in this order:

1. Notifications for every watched repository.
2. Repository-wide streams and default-branch CI for every watched repository.
3. Pull requests of open Tickets.
4. Subscribed Threads.

Each step and each repository stream records its own failures, and the round throws only after all steps have run. The GitHub health entry reports the notification count, the next polling interval (`X-Poll-Interval` or `pollSeconds`), and any deleted, abandoned, unreadable, filtered or duplicate items.

## Workspace preparation

A worktree inherits its clone's `remote.origin`. If two repositories shared one clone, every Ticket's worktree would push to whichever repository was cloned first. The design therefore keeps one clone per watched repository.

The recommended prepare command, as stored in the Execution settings, is:

```sh
root=/home/me/src
repo="$DSH_SUPERAGENT_GITHUB_REPOSITORY"
dir="$root/$(printf '%s' "$repo" | sed 's|/|__|g')"
[ -e "$dir/.git" ] || git clone --no-checkout "https://github.com/$repo.git" "$dir"
git -C "$dir" fetch --no-tags "https://github.com/$repo.git" \
  "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
[ -e "$DSH_SUPERAGENT_DIR/.git" ] || \
  git -C "$dir" worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" \
    "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
```

- `owner/name` becomes `owner__name`, so the clone stays one path segment under the clone root.
- The clone is created on first use; later Tickets for that repository reuse it.
- The Ticket's ref is fetched from that repository, and its worktree is added from that clone.
- Re-running the command for a prepared workspace only fetches again and leaves the existing clone and worktree alone.
- A failed step exits non-zero, so a Ticket never starts in a half-prepared workspace.

The repository ships a renderer for this command, [`src/executor/prepare.ts`](../src/executor/prepare.ts), with `prepareCommand(repository, options)` for a single repository and `prepareScript(options)` for the deployment-wide command that reads `DSH_SUPERAGENT_GITHUB_REPOSITORY`. The renderer quotes shell values and lets a deployment supply its clone root, GitHub base URL and optional proxy. Its test, [`tests/executor-prepare.spec.ts`](../tests/executor-prepare.spec.ts), runs two local remotes through the rendered command and checks that each worktree's `remote.origin` and push URL name its own repository. The runtime does not generate the stored command itself: the operator saves it once in the Execution settings, and the environment variable makes it choose the Ticket's repository.

## Migration and rollback

A database written by a single-repository version stores bare Thread IDs (`github:12`, `github:ci:main`) and bare-number cursors and retries. Watching several repositories could make `#12` read the wrong repository, so the database must be converted before the new code uses it.

`SCHEMA_VERSION` is 12. On startup, `Store` opens the database, creates the current tables, runs the schema 11 migration when needed, then runs `migrateTo12` inside the same transaction. If any migration step fails, the transaction rolls back, the database file is left unchanged, and the service refuses to start with an error that names schema 12. There is no partially converted state.

`migrateTo12` first determines the one repository the old records belonged to (`legacyRepository`):

- It reads GitHub Issue and pull-request URLs and repository-qualified IDs from the `thread`, `trigger`, `ticket`, `decision` and `outbox` tables and from `github-` KV keys and values.
- If those records name none, it reads the one repository in the saved GitHub Source settings, either the deprecated `repository` value or a `repositories` row.
- If the records and settings together name one repository, that is the repository. If they name several or none, the migration fails rather than silently moving Threads to a repository they may not belong to.

The migration then rewrites, in the same transaction:

| Record | Change |
| --- | --- |
| `thread` | Thread key and `ref.id` from `12` to `owner/name#12`; CI from `ci:main` to `owner/name#ci:main` |
| `trigger` | Every GitHub Thread reference, and the Channel's Thread key |
| `trigger_thread` | The Thread column; a duplicate row is dropped when the renamed Thread already holds the Trigger |
| `ticket` | Channel Thread keys and followed Threads |
| `decision` | The Thread column and the decision's `threadKey` |
| `outbox` | The receipt's Channel Thread key |
| `github-cursor:`, `github-ci:` | The ID after the family prefix; when both old and new records exist, the later cursor or the higher CI revision is kept |
| `github-retry` | The map's keys; when both entries exist, the earlier `since` is kept |

The saved settings are not rewritten. The deprecated `repository` value remains readable, `repositoryRows` shows it as the panel's row, and saving the panel stores `repositories` and clears `repository`. That keeps an upgraded deployment's watch list identical until the operator edits it.

Rollback is a restore, not a downgrade: take a copy of the state directory before the upgrade, keep the previous settings, and restore both with the previous code. The older code cannot read repository-qualified keys. [006 Deployment](006-deployment.md) states this for the operator.

## Panel

The panel does not need a per-repository page. The GitHub Source's settings field is a rows editor, so the watched repositories are one list in one Source. The deprecated single value is projected into that list, and saving writes the rows. The Deployment page shows the resolved canonical repository names as facts. Threads, Tickets and Triggers show their full Thread IDs, and a link is built from the repository in the Thread, not from the Source's first repository.

The panel's setup state, Source health and status counts remain one set for the whole deployment. A repository that fails to resolve is a setup problem on the GitHub Source, not a separate Source instance.

## Design choices

| Choice | Rejected alternative | Why |
| --- | --- | --- |
| One Source watching several repositories | One deployment per repository | One agent account and one notification list; separate deployments would split events, Policy, queue and panel |
| Repository-qualified Thread ID (`owner/name#12`) | A deployment-wide prefix or a bare number plus a repository lookup | The ID is the single source of the repository fact; every key and read derives from it |
| `owner/name#number` | A composite key with another separator | It keeps GitHub's spelling, reads naturally in a URL or prompt, and only requires handling the one `/` in path names |
| Account-wide `github-since` plus a processed-ID ledger | One cursor per repository | The notification list is account-wide and GitHub publishes late; the ledger makes the lookback idempotent |
| A per-repository lookback window | A cursor advanced from the last round's start | It recovers notifications GitHub indexed after their `updated_at` |
| One clone per repository; one worktree per Ticket | One shared clone with a per-push URL | A worktree inherits `remote.origin`; a shared clone makes the wrong repository the default push target |
| A stored prepare command that reads `DSH_SUPERAGENT_GITHUB_REPOSITORY` | A separate prepare command per repository | The settings have one command; the environment variable carries the repository |
| Startup migration in one transaction | Lazy conversion on every read | Readers stay simple and a failed conversion leaves the old database intact |
| Refuse an ambiguous migration | Pick the first or the most recent repository | A guess would silently move Threads and reads to the wrong repository |
| One repository per Ticket workspace | Multi-repository Ticket workspaces | The Ticket's Thread names its repository; a request that spans repositories is separate work with its own Tickets |

## Limits and open questions

- **At most 20 repositories.** Every watched repository adds notification, stream and CI calls to every round. A deployment that must cover more has to raise the limit deliberately, at the cost of more calls per round.
- **A repository rename is not a schema migration.** Setup resolves the current canonical `full_name`, and new events use it, but Thread keys and clone directories under the previous name are not rewritten. The same repository can therefore appear under two names in old records, so treat a rename as a follow-up.
- **One workspace, one repository.** The Ticket's prepare command prepares the repository of its Thread. A Ticket that must change two repositories is separate work and should be split into one Ticket per repository; the environment provides one clone, not one per watched repository.
- **A pruned ledger can re-list after a long pause.** The 30-day, 5000-ID ledger is an optimisation, not the source of truth; deterministic Trigger IDs keep a re-read from creating a second Trigger.
- **Notifications are read per repository sequentially.** A slow repository delays the round. The lookback window and per-repository cursors let the next round catch up, but a deployment with many slow repositories will poll less often.
- **The migration needs a nameable repository.** A database whose records and settings name no repository, or more than one, cannot be upgraded automatically; the operator must attribute it to one repository, for example by setting that repository in the Source settings.

## Implementation map

| File | Responsibility |
| --- | --- |
| [`src/deployment.ts`](../src/deployment.ts) | `GithubAccountsSchema`, `MAX_REPOSITORIES`, `watchedRepositories`, `repositoryRows`, canonical repository resolution and push checks, `primaryRepository` |
| [`src/sources/github-trigger.ts`](../src/sources/github-trigger.ts) | Thread IDs and keys, legacy parsing, `threadRepository`, URL addresses, Channels and pages |
| [`src/sources/github.ts`](../src/sources/github.ts) | Source configuration and fields, notification polling, ledger and retries, repository streams, CI, round health, execution variables |
| [`src/sources/github-read.ts`](../src/sources/github-read.ts) | Thread context reads addressed to the Thread's repository |
| [`src/sources/github-pull.ts`](../src/sources/github-pull.ts) | Pull request reads, observation and completion by repository |
| [`src/sources/github-channel.ts`](../src/sources/github-channel.ts) | Replies to the repository and number in the Channel address |
| [`src/infra/commands.ts`](../src/infra/commands.ts) | `Commands.for(repository)` and the `repos/<repository>/` path restriction |
| [`src/kv.ts`](../src/kv.ts) | Repository- and Thread-scoped state keys |
| [`src/app/migration.ts`](../src/app/migration.ts) | `migrateTo12`, `legacyRepository`, and the record rewrites |
| [`src/app/store.ts`](../src/app/store.ts) | The startup transaction that runs the migration |
| [`src/executor/prepare.ts`](../src/executor/prepare.ts) | The one-clone-per-repository prepare command renderer |
| [`src/app/execution-environment.ts`](../src/app/execution-environment.ts) | Ticket and Source execution variable assembly; the GitHub Source declares `DSH_SUPERAGENT_GITHUB_REPOSITORY` |
| [`src/client/deployment.tsx`](../src/client/deployment.tsx) | The Deployment page's resolved repository list |
| [`src/client/settings-kit.tsx`](../src/client/settings-kit.tsx) | The rows editor the Source settings use |

## Tests

| Test | Covers |
| --- | --- |
| [`tests/executor-prepare.spec.ts`](../tests/executor-prepare.spec.ts) | One clone per repository, idempotent re-runs, and worktrees bound to their own remote |
| [`tests/migration.spec.ts`](../tests/migration.spec.ts) | The schema 12 rewrite, the refusal when records name no repository or several, and an unchanged database when a step fails |
| [`tests/sources.spec.ts`](../tests/sources.spec.ts) | Listing every watched repository's notifications, reading each notification once, the lookback and ledger, and Threads keyed by repository |
| [`tests/commands.spec.ts`](../tests/commands.spec.ts) | GitHub calls restricted to the configured repository and repository-scoped replies |
| [`tests/deployment.spec.ts`](../tests/deployment.spec.ts) | Reading the watch list, canonical names, and the push check for each repository |
| [`tests/panel-source.spec.tsx`](../tests/panel-source.spec.tsx) | Showing a deprecated single repository as a row and saving the rows |
| [`tests/docs.spec.ts`](../tests/docs.spec.ts) | Numbered-document order, resolvable links, and the module and test tables |

`pnpm check` runs the typecheck, the tests and the build. The documentation test also checks that this document is numbered after the earlier ones, links only backwards, and keeps every local link resolvable.
