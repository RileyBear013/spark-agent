import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { LocalSkillCatalog, defaultSkillRoots, localSkillId } from '../../src/skills/catalog.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('LocalSkillCatalog', () => {
  it('discovers project and user skills and lets the more specific project skill win', async () => {
    const root = await workspace()
    const home = join(root, 'home')
    await writeSkill(home, '.agents/skills/shared', 'Shared', 'Global description', 'global body')
    await writeSkill(root, '.spark/skills/shared', 'Shared', 'Project description', 'project body')
    await writeSkill(root, '.claude/skills/local', 'Local', 'Local description', 'local body')

    const catalog = new LocalSkillCatalog({ cwd: root, home })
    const entries = await catalog.list()

    expect(entries.map((entry) => entry.name)).toEqual(['Local', 'Shared'])
    expect(entries.find((entry) => entry.name === 'Shared')).toMatchObject({
      id: localSkillId('project', 'spark', 'Shared'),
      description: 'Project description',
      scope: 'project',
      provider: 'spark',
    })
  })

  it('supports searching, explicit loading by id or name, and strips frontmatter', async () => {
    const root = await workspace()
    const skillPath = await writeSkill(
      root,
      '.agents/skills/verify',
      'Verify Change',
      'Run focused validation',
      '# Verify\n\nRun the test suite.',
    )
    const catalog = new LocalSkillCatalog({ cwd: root, home: join(root, 'empty-home') })

    const searched = await catalog.list({ query: 'focused' })
    expect(searched).toHaveLength(1)
    expect(searched[0]?.skillFilePath).toBe(skillPath)

    await expect(catalog.load('Verify Change')).resolves.toMatchObject({
      name: 'Verify Change',
      body: '# Verify\n\nRun the test suite.',
    })
    await expect(catalog.load(searched[0]!.id)).resolves.toMatchObject({
      body: '# Verify\n\nRun the test suite.',
    })
  })

  it('skips malformed documents and enforces the load size boundary', async () => {
    const root = await workspace()
    await mkdir(join(root, '.agents', 'skills', 'bad'), { recursive: true })
    await writeFile(join(root, '.agents', 'skills', 'bad', 'SKILL.md'), 'not frontmatter', 'utf8')
    await writeSkill(root, '.agents/skills/large', 'Large', 'Large description', 'x'.repeat(200))

    const catalog = new LocalSkillCatalog({
      cwd: root,
      home: join(root, 'empty-home'),
      maxFileBytes: 128,
    })
    expect(await catalog.list()).toEqual([])
    await expect(catalog.load('Large')).rejects.toThrow(/not found|exceeds/u)
  })

  it('exposes deterministic root ordering for diagnostics', async () => {
    const root = await workspace()
    const paths = defaultSkillRoots(root, join(root, 'home')).map((item) => item.path)
    expect(paths.slice(0, 4)).toEqual([
      join(root, 'home', '.claude/skills'),
      join(root, 'home', '.codex/skills'),
      join(root, 'home', '.agents/skills'),
      join(root, 'home', '.spark/skills'),
    ])
    expect(paths.at(-1)).toBe(join(root, '.spark/skills'))
  })
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'spark-skills-'))
  roots.push(root)
  return root
}

async function writeSkill(
  root: string,
  relativeDirectory: string,
  name: string,
  description: string,
  body: string,
): Promise<string> {
  const directory = join(root, relativeDirectory)
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'SKILL.md')
  await writeFile(path, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, 'utf8')
  return path
}
