import type { Context } from '@deepseek-ai/cordis'
import type { SourceHost } from './sources/host.ts'
/**
 * This installation's namespace: the suffix it appends to the DSH service it provides, the tools it registers and the
 * management route it serves, so two installations (this GitHub one and a Gerrit one) can run in the same DSH process
 * without registering the same names. Empty for the first installation, whose names stay those of earlier releases.
 */
export const NAMESPACE = ''
/** The Cordis service the Source plugins inject; one installation may provide only one of each name. */
export const serviceName = NAMESPACE ? `orchestrator-${NAMESPACE}` : 'orchestrator'
/** The web route prefix of the management API and panel. */
export const routeBase = `/orchestrator${NAMESPACE ? `-${NAMESPACE}` : ''}`
/** The tool name of one main-Session command, namespaced so another installation's copy never collides. */
export const toolName = (verb: string): string => `orchestrator_${NAMESPACE ? `${NAMESPACE}_` : ''}${verb}`
/** Rewrites tool names written in prompt text, skill text and messages the way `toolName` builds them. */
export const namespaced = (text: string): string => NAMESPACE ? text.replaceAll('orchestrator_', `orchestrator_${NAMESPACE}_`) : text
/** The dsh-superagent instance of this namespace, which a Source plugin registers with instead of a fixed service name. */
export const sourceHost = (ctx: Context): SourceHost => ctx.get(serviceName) as unknown as SourceHost
