/**
 * useTeamStoreBadge — 侧栏「团队商店」可更新角标
 *
 * 聚合五类团队资产的 remote-newer 数量（工作流/助手/应用信封三通道 + 技能 + MCP）。
 * 未配置团队注册中心时恒为 0；90s 轮询 + 窗口聚焦刷新；失败静默保持上次值。
 * 独立小模块：App 侧栏静态引入而不拖入整个商店视图（商店视图保持 lazy 分包）。
 */
import { useEffect, useState } from 'react'
import { useIpcInvoke } from './useIpc'

export function useTeamStoreBadge(): number {
  const { invoke: getConfig } = useIpcInvoke('team-registry:config-get')
  const { invoke: listAssetUpdates } = useIpcInvoke('team-registry:list-asset-updates')
  const { invoke: listSkillUpdates } = useIpcInvoke('team-registry:list-updates')
  const { invoke: listMcpUpdates } = useIpcInvoke('team-registry:list-mcp-updates')
  const [count, setCount] = useState(0)

  useEffect(() => {
    let alive = true
    let busy = false
    const refresh = async () => {
      if (busy) return
      busy = true
      try {
        const cfg = await getConfig({})
        if (!alive) return
        if (!cfg.snapshot.configured) {
          setCount(0)
          return
        }
        const [uwf, uag, uap, usk, umc] = await Promise.allSettled([
          listAssetUpdates({ assetType: 'workflow' }),
          listAssetUpdates({ assetType: 'agent' }),
          listAssetUpdates({ assetType: 'app' }),
          listSkillUpdates({}),
          listMcpUpdates({}),
        ])
        if (!alive) return
        const n = (r: PromiseSettledResult<{ updates: Array<{ state: string }> }>): number =>
          r.status === 'fulfilled'
            ? r.value.updates.filter((u) => u.state === 'remote-newer').length
            : 0
        setCount(n(uwf) + n(uag) + n(uap) + n(usk) + n(umc))
      } catch {
        // 角标是增强信息：失败保持上次值
      } finally {
        busy = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 90_000)
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [getConfig, listAssetUpdates, listSkillUpdates, listMcpUpdates])

  return count
}
