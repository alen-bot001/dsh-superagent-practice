# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one or more GitHub repositories, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Multiple repositories

The GitHub Source watches the repositories in its rows, up to 20, so one deployment can serve several repositories. Each Ticket still works in the repository of the Thread that started it, and each repository keeps its own identity everywhere. [009 Multi-repository support](docs/009-multi-repository.md) has the design and implementation; in short:

- **Threads.** A Thread is `github:owner/name#12`, or `github:owner/name#ci:main` for default-branch CI, because two repositories that both number an Issue `#12` hold two different conversations. A Thread ID written before IDs named a repository (`12`, `ci:main`) still parses, under the repository the migration read from its records. Read positions, CI fingerprints and retries are keyed the same way.
- **One clone per repository.** The prepare command keeps a clone per repository, named `owner__name` under the clone root, and adds each Ticket's worktree from its own repository's clone. A worktree inherits its clone's `remote.origin`, so a shared clone would push every Ticket to whichever repository was cloned first. [docs/006-deployment.md](docs/006-deployment.md) has the command.
- **Notifications.** A poll lists notifications for every watched repository and merges them. A cursor alone drops the notifications GitHub publishes later than their `updated_at`, so each round also reaches back `lookbackSeconds` (default 900), and a processed-notification ledger (`github-notices`, 30 days, at most 5000 ids) drops the ones already handled. `pollSeconds` is the interval between rounds.
- **Migration and rollback.** Opening a database written by a single-repository version migrates it on startup to repository-scoped Thread keys, read cursors and retries, and either completes or leaves the database file unchanged; take a copy of the state directory first. Rolling back means restoring that copy together with the previous settings, because the older code cannot read repository-scoped keys.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source
- [009 Multi-repository support](docs/009-multi-repository.md): design and implementation of watching several repositories

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
