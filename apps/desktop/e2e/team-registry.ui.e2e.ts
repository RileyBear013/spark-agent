/**
 * Team registry UI walkthrough — M1.5/M2 界面自查
 *
 * 覆盖（隔离 userData 的生产模式实例，真实点击导航）：
 * 1. 设置 → 团队注册中心分区渲染（未配置降级态、四个输入框、操作按钮）
 * 2. 真实保存配置 + 连接测试（直连团队 Nacos 测试机）
 * 3. 团队商店：分类页签 + 共享资产卡片 + 详情抽屉（配置后）
 * 4. 团队商店「上传共享」面板：三类页签 + 本地资产列表（行/空态）
 *
 * 测试机是团队测试环境（Nacos 默认账号），不涉及生产数据。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'

const DESKTOP_ROOT = resolve(__dirname, '..')
const MAIN_ENTRY = join(DESKTOP_ROOT, 'out/main/index.js')

const TEST_REGISTRY = {
  baseUrl: 'http://192.168.163.174:8080',
  namespace: 'public',
  username: 'nacos',
  password: 'nacos',
}

async function dismissOnboarding(page: Page): Promise<void> {
  const skip = page.getByRole('button', { name: '稍后再说', exact: true })
  const sidebar = page.locator('.floating-sidebar')
  await expect
    .poll(async () => {
      if (await skip.isVisible().catch(() => false)) return 'onboarding'
      if (await sidebar.isVisible().catch(() => false)) return 'shell'
      return 'loading'
    })
    .not.toBe('loading')
  if (await skip.isVisible().catch(() => false)) await skip.click()
  await expect(sidebar).toBeVisible()

  const optionalCapabilityLater = page.getByRole('button', { name: /^稍\s*后$/ })
  let quietRounds = 0
  for (let attempt = 0; attempt < 30 && quietRounds < 3; attempt += 1) {
    await page.waitForTimeout(500)
    if (await optionalCapabilityLater.isVisible().catch(() => false)) {
      await optionalCapabilityLater.click()
      quietRounds = 0
    } else {
      quietRounds += 1
    }
  }
  await expect(page.locator('.ant-modal-wrap:visible')).toHaveCount(0, { timeout: 5_000 })
}

test.describe.serial('Team registry UI walkthrough', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataPath: string
  let pageErrors: Error[]

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    userDataPath = await mkdtemp(join(tmpdir(), 'spark-team-registry-e2e-'))
    pageErrors = []
    electronApp = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataPath}`, '--disable-gpu', '--no-sandbox'],
      cwd: DESKTOP_ROOT,
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        NODE_ENV: 'production',
        SPARK_ALLOW_MULTIPLE_INSTANCES: '1',
        SPARK_SKIP_PROTOCOL_REGISTRATION: '1',
        SPARK_AUTH_KEYTAR_SERVICE: `SparkAgent.CloudAuth.E2E.TeamRegistry.${process.pid}`,
        SPARK_DISABLE_DEVTOOLS: '1',
      },
      timeout: 60_000,
    })
    page = await electronApp.firstWindow({ timeout: 30_000 })
    page.on('pageerror', (error) => pageErrors.push(error))
    await page.waitForLoadState('domcontentloaded')
    await dismissOnboarding(page)
  })

  test.afterAll(async () => {
    await electronApp?.close().catch(() => {})
    await rm(userDataPath, { recursive: true, force: true })
  })

  test('settings section renders with unconfigured degraded state', async () => {
    test.setTimeout(120_000)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '团队注册中心' }).click()
    await expect(page.locator('.team-registry-section h2')).toHaveText('团队注册中心')
    await expect(page.getByText(/未配置/)).toBeVisible()
    await expect(page.getByPlaceholder('http://<nacos-host>:8080')).toBeVisible()
    await expect(page.getByPlaceholder('public')).toBeVisible()
    await expect(page.getByPlaceholder('Nacos 控制台账号')).toBeVisible()
    // 密码框占位符随 hasPassword 变化（钥匙串是机器级，非 profile 级），按结构定位
    await expect(
      page.locator('.team-registry-section .team-registry-field', { hasText: '密码' }).locator('input'),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: '测试连接' })).toBeVisible()
    await expect(page.getByRole('button', { name: '保存配置' })).toBeVisible()
  })

  test('saves config and passes live connection test', async () => {
    test.setTimeout(120_000)
    await page.getByPlaceholder('http://<nacos-host>:8080').fill(TEST_REGISTRY.baseUrl)
    await page.getByPlaceholder('public').fill(TEST_REGISTRY.namespace)
    await page.getByPlaceholder('Nacos 控制台账号').fill(TEST_REGISTRY.username)
    await page
      .locator('.team-registry-section .team-registry-field', { hasText: '密码' })
      .locator('input')
      .fill(TEST_REGISTRY.password)
    await page.getByRole('button', { name: '保存配置' }).click()
    // 真实网络：登录团队 Nacos + 读命名空间，断言成功状态
    await expect(page.getByText(/已保存并连接成功/)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/未配置/)).toHaveCount(0)
  })

  test('team store lists shared assets with category tabs', async () => {
    test.setTimeout(120_000)
    // 设置页是全屏视图，先返回工作台主壳层，浮动侧边栏才可见
    await page.getByRole('button', { name: '返回工作台' }).click()
    await expect(page.locator('.floating-sidebar')).toBeVisible()
    await page.locator('.floating-sidebar').getByRole('button', { name: '团队商店' }).click()
    await expect(page.locator('.team-store-header h2')).toContainText('团队商店')
    // 分类页签齐全
    for (const tab of ['全部', '应用', '工作流', '助手', '技能', 'MCP']) {
      await expect(page.locator('.team-store-cat', { hasText: tab }).first()).toBeVisible()
    }
    // 注册中心已有共享资产（团队测试库），等待首张卡片渲染
    await expect(page.locator('article.team-store-card').first()).toBeVisible({ timeout: 15_000 })
    // 详情抽屉：点首张卡片出元数据与操作区
    await page.locator('article.team-store-card').first().click()
    await expect(page.locator('.team-store-detail')).toBeVisible()
    await expect(page.getByRole('button', { name: /版本历史/ })).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('team store upload panel lists local assets for publishing', async () => {
    test.setTimeout(120_000)
    await expect(page.locator('.team-store-header')).toBeVisible()
    await page.getByRole('button', { name: '上传共享' }).click()
    await expect(page.getByText('上传共享到团队')).toBeVisible()
    // 三类页签齐全，默认工作流
    for (const tab of ['工作流', '应用', '助手']) {
      await expect(page.getByRole('tab', { name: tab })).toBeVisible()
    }
    // 隔离 profile 本地资产数不确定：等待行列表或空态二选一出现
    await expect(
      page.locator('.team-store-pub-row').first().or(page.locator('.team-store-pub-empty')),
    ).toBeVisible({ timeout: 15_000 })
    // 切到「应用」页签同样能加载（行或空态）
    await page.getByRole('tab', { name: '应用' }).click()
    await expect(
      page.locator('.team-store-pub-row').first().or(page.locator('.team-store-pub-empty')),
    ).toBeVisible({ timeout: 15_000 })
    await page.keyboard.press('Escape')
    expect(pageErrors).toEqual([])
  })
})