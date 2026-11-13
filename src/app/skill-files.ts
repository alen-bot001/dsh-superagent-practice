/** Loads packaged built-in skill definitions and prompt templates from disk. */
import { namespaced } from '../identity.ts'
import { readFileSync } from 'node:fs'
import { packagePath } from '../infra/paths.ts'
/**
 * Reads a packaged text file with normalized Unix line endings.
 * @throws Naming the file when it is missing or whitespace-only, because `dsh-superagent` cannot load without it.
 */
function packaged(...parts: string[]): { path: string; text: string } {
  const path = packagePath(...parts)
  let text: string
  try { text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n') }
  catch (error) {
    throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`Missing packaged file: ${path}`, { cause: error }) : error
  }
  if (!text.trim()) throw new Error(`Empty packaged file: ${path}`)
  return { path, text }
}
function load(name: string) {
  const { path, text } = packaged('skills', `dsh-superagent-${name}`, 'SKILL.md')
  const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`Invalid packaged skill: ${path}`)
  return { name: match[1]!, description: match[2]!, content: match[3]!, path }
}
const rawSkills = { feishu: load('feishu'), github: load('github') }
/** Skill text the agent reads, with this installation's tool namespace applied. */
export const bundledSkills = { feishu: { ...rawSkills.feishu, content: namespaced(rawSkills.feishu.content) },
  github: { ...rawSkills.github, content: namespaced(rawSkills.github.content) } }
/**
 * Loads a built-in prompt file (`prompts/<name>.md`). Source `.md` files are written one sentence per line for
 * readable diffs; `promptFile` joins lines within each paragraph with spaces while keeping blank-line paragraph breaks.
 */
function rawPromptFile(name: string): string {
  const paragraphs = packaged('prompts', `${name}.md`).text.trim().split(/\n(?:[ \t]*\n)+/)
  return paragraphs.map(paragraph => paragraph.split('\n').map(line => line.trim()).join(' ')).join('\n')
}
/** The built-in prompt text of `name`, with this installation's tool namespace applied. */
export const promptFile = (name: string): string => namespaced(rawPromptFile(name))
