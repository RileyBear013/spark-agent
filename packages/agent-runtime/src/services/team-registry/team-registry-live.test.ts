/**
 * 真机集成探针（默认跳过）——团队 Nacos 注册中心原生 API 全链路验证
 *
 * 运行方式（测试环境专用，探针数据用后即删）：
 *   TEAM_REGISTRY_LIVE=1 npx vitest run src/services/team-registry/team-registry-live.test.ts
 *
 * 可用 env 覆盖目标：TEAM_REGISTRY_URL / TEAM_REGISTRY_USER / TEAM_REGISTRY_PASS
 * 验证内容与 docs/plan/team-registry-sharing.md「真机联调记录」对齐：
 * 登录 → 技能 zip（precheck/upload/submit/publish/online/scope/下载保真）→
 * MCP（draft 回读校验/submit/publish/online/列表）→ 全部探针清理。
 */
import { describe, expect, it } from 'vitest'
import { NacosClient } from './nacos-client.js'
import { buildMcpDraftFields, specToLocalConfigJson } from './mcp-mapping.js'
import { buildZip, readZip, stripZipCommonRoot } from './zip.js'

const LIVE = process.env.TEAM_REGISTRY_LIVE === '1'
const URL_ = process.env.TEAM_REGISTRY_URL ?? 'http://192.168.163.174:8080'
const USER = process.env.TEAM_REGISTRY_USER ?? 'nacos'
const PASS = process.env.TEAM_REGISTRY_PASS ?? 'nacos'
const NS = 'public'
const SLUG = 'spark-live-probe'
const MCP_SLUG = 'spark-live-probe-mcp'

describe.skipIf(!LIVE)('team-registry 真机探针（TEAM_REGISTRY_LIVE=1）', () => {
  const client = new NacosClient({ serverUrl: URL_, namespace: NS, username: USER, password: PASS })

  const skillZip = (version: string) =>
    buildZip([
      {
        path: 'SKILL.md',
        content: Buffer.from(
          `---\nname: ${SLUG}\ndescription: live probe skill\nversion: ${version}\n---\n\nprobe body\n`,
          'utf-8',
        ),
      },
      { path: 'references/guide.md', content: Buffer.from('# 指南\n附属资源', 'utf-8') },
    ])

  async function cleanup(): Promise<void> {
    await client.deleteTeamSkill(SLUG).catch(() => {})
    await client.deleteTeamMcpServer(MCP_SLUG).catch(() => {})
  }

  it('技能 zip 全生命周期 + 下载保真', async () => {
    await cleanup()
    try {
      const health = await client.testRoundTrip()
      expect(health.healthy, health.error).toBe(true)

      const zip = skillZip('0.1.0')
      const pre = await client.precheckTeamSkillUpload(zip)
      expect(pre?.precheckCode).toBe('READY')
      expect(pre?.skillName).toBe(SLUG)
      expect(pre?.targetVersion).toBe('0.1.0')

      expect(
        await client.uploadTeamSkillZip({ zip, overwrite: false, commitMsg: 'live probe' }),
      ).toBe(SLUG)
      await client.submitTeamSkillVersion(SLUG, '0.1.0')
      await client.publishTeamSkillVersion(SLUG, '0.1.0')
      await client.onlineTeamSkillVersion(SLUG, '0.1.0').catch(() => {})
      await client.setTeamSkillScope(SLUG, 'PUBLIC')

      const detail = await client.getTeamSkill(SLUG)
      expect(detail).not.toBeNull()
      expect(detail?.scope).toBe('PUBLIC')
      expect(detail?.versions.map((v) => v.version)).toContain('0.1.0')

      // 下载保真：zip 内 SKILL.md / 附属文件与上传一致
      const downloaded = await client.downloadTeamSkillVersion(SLUG, '0.1.0')
      const entries = stripZipCommonRoot(readZip(downloaded))
      const skillMd = entries.find((e) => e.path === 'SKILL.md')
      expect(skillMd?.content.toString('utf-8')).toContain(`name: ${SLUG}`)
      expect(entries.map((e) => e.path)).toContain('references/guide.md')
    } finally {
      await cleanup()
    }
  })

  it('MCP draft→publish 全生命周期 + 回读校验 + 清理', async () => {
    await cleanup()
    try {
      const fields = buildMcpDraftFields({
        mcpName: MCP_SLUG,
        version: '0.1.0',
        namespaceId: NS,
        configJson: JSON.stringify({
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-echo'],
        }),
        description: 'live probe mcp',
      })
      await client.createTeamMcpDraft(fields)
      // 孤儿行防御验证：创建后必须能回读到版本行
      const detail = await client.getTeamMcpServer(MCP_SLUG)
      expect(detail).not.toBeNull()
      expect(detail?.versions.map((v) => v.version)).toContain('0.1.0')

      await client.submitTeamMcpVersion(MCP_SLUG, '0.1.0')
      await client.publishTeamMcpVersion(MCP_SLUG, '0.1.0')
      await client.onlineTeamMcpVersion(MCP_SLUG, '0.1.0').catch(() => {})

      const after = await client.getTeamMcpServer(MCP_SLUG)
      expect(after?.serverSpecification?.protocol).toBe('stdio')
      // 平铺 spec 形态应能映射回本地 stdio 配置
      const localConfig = specToLocalConfigJson(after?.serverSpecification)
      expect(localConfig).not.toBeNull()
      expect(JSON.parse(localConfig!)).toMatchObject({ transport: 'stdio', command: 'npx' })

      const list = (await client.listTeamMcpServers()).items
      expect(list.some((s) => (s.mcpName ?? s.name) === MCP_SLUG)).toBe(true)
    } finally {
      await cleanup()
    }
  })
})
