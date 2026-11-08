/** Default deployment and machine fixtures for tests. */
import type { Volatile } from '@deepseek-ai/cordis'
import type { Deployment, Machine } from '../../src/deployment.ts'

/** Mutable Volatile reference for simulating live configuration updates. */
export const reference = <T>(value: T): Volatile<T> & { set(next: T): void } => {
  let current = value
  return { get: () => current as never, set: next => { current = next } }
}
export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  stateDir: '/tmp/dsh-superagent-test', promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
  admissionContextTimeoutMs: reference(15000), ...overrides,
})
/**
 * A resolved deployment watching `acme/widgets`. `repository` stays accepted as a short way to name the one watched
 * repository, so tests that predate several repositories keep reading as they did.
 */
export const testDeployment = (overrides: Partial<Deployment> & { repository?: string } = {}): Deployment => {
  const { repository, ...rest } = overrides
  return {
    ...testMachine(), repositories: repository ? [repository] : ['acme/widgets'],
    github: { cli: '/bin/false', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' },
    feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
    ...rest,
  }
}
