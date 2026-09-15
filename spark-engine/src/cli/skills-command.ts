import { createRuntimeLogger } from '../observability/logger.js'
import { LocalSkillCatalog, type LoadedSkill, type SkillCatalogEntry } from '../skills/catalog.js'

export interface SkillsCommandOptions {
  readonly cwd: string
  readonly home?: string
  readonly subcommand: string
  readonly args: readonly string[]
  readonly json: boolean
  readonly limit?: string
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

export async function executeSkillsCommand(options: SkillsCommandOptions): Promise<number> {
  if (!['', 'list', 'read'].includes(options.subcommand)) {
    options.stderr(`Unknown \`spark skills\` subcommand: ${options.subcommand} (list | read)\n`)
    return 2
  }
  const catalog = new LocalSkillCatalog({
    cwd: options.cwd,
    ...(options.home === undefined ? {} : { home: options.home }),
    logger: createRuntimeLogger('cli'),
  })
  try {
    if (options.subcommand === 'read') return await readSkill(catalog, options)
    return await listSkills(catalog, options)
  } catch (error) {
    options.stderr(`${errorMessage(error)}\n`)
    return 1
  }
}

async function listSkills(
  catalog: LocalSkillCatalog,
  options: SkillsCommandOptions,
): Promise<number> {
  const query = options.args.join(' ').trim()
  const entries = await catalog.list({
    ...(query.length === 0 ? {} : { query }),
    ...(options.limit === undefined ? {} : { limit: parseLimit(options.limit) }),
  })
  if (options.json) {
    options.stdout(
      `${JSON.stringify({ skills: entries.map(skillView), total: entries.length }, null, 2)}\n`,
    )
    return 0
  }
  if (entries.length === 0) {
    options.stdout('No local skills found.\n')
    return 0
  }
  for (const entry of entries) {
    options.stdout(
      `[${entry.id}] ${entry.name} (${entry.scope}/${entry.provider})\n` +
        `  ${entry.description}\n` +
        `  ${entry.skillFilePath}\n`,
    )
  }
  return 0
}

async function readSkill(
  catalog: LocalSkillCatalog,
  options: SkillsCommandOptions,
): Promise<number> {
  if (options.args.length !== 1) {
    options.stderr('Usage: spark skills read <id-or-name>\n')
    return 2
  }
  const selector = options.args[0]
  if (selector === undefined) {
    options.stderr('Usage: spark skills read <id-or-name>\n')
    return 2
  }
  const skill = await catalog.load(selector)
  if (options.json) {
    options.stdout(`${JSON.stringify({ skill: loadedSkillView(skill) }, null, 2)}\n`)
    return 0
  }
  options.stdout(
    `Skill: ${skill.name}\n` +
      `ID: ${skill.id}\n` +
      `Source: ${skill.scope}/${skill.provider}\n` +
      `Path: ${skill.skillFilePath}\n\n` +
      `${skill.body}\n`,
  )
  return 0
}

function skillView(entry: SkillCatalogEntry): Record<string, string> {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    scope: entry.scope,
    provider: entry.provider,
    path: entry.skillFilePath,
  }
}

function loadedSkillView(skill: LoadedSkill): Record<string, string> {
  return { ...skillView(skill), instructions: skill.body }
}

function parseLimit(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new Error('limit must be an integer from 1 to 200')
  }
  return parsed
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
