/**
 * @module team-registry/team-registry-config
 *
 * 团队注册中心配置存取 — 非密配置进 settings 表，密码进系统 Keychain
 *
 * 与 PlatformCredentialStore 同一套模式：
 *   - settings（category = 'team-registry'）：serverUrl / namespace / username
 *   - keystore：password（永不进 IPC 响应与日志，getSnapshot 只回 hasPassword）
 */

import * as keystore from '@spark/shared/keystore'
import { SettingsRepository } from '@spark/storage'
import type { SparkDatabase } from '@spark/storage'
import { NacosClient } from './nacos-client.js'

export const TEAM_REGISTRY_SETTINGS_CATEGORY = 'team-registry'

export interface TeamRegistryConfigSnapshot {
  configured: boolean
  serverUrl: string
  namespace: string
  username: string
  hasPassword: boolean
}

export interface TeamRegistryConfigInput {
  serverUrl: string
  namespace: string
  username: string
  /** 不传 = 保留旧密码；传空串 = 清除密码 */
  password?: string
}

function passwordRef(): keystore.KeystoreRef {
  return keystore.makeKeystoreRef('team-registry', 'nacos-password')
}

export class TeamRegistryConfigStore {
  private readonly settings: SettingsRepository

  constructor(db: SparkDatabase) {
    this.settings = new SettingsRepository(db)
  }

  /** UI 展示用快照（不含密码明文） */
  async getSnapshot(): Promise<TeamRegistryConfigSnapshot> {
    const serverUrl = this.readString('server-url')
    const namespace = this.readString('namespace') || 'public'
    const username = this.readString('username')
    const hasPassword = await keystore.hasSecret(passwordRef())
    return {
      configured: Boolean(serverUrl) && Boolean(username) && hasPassword,
      serverUrl,
      namespace,
      username,
      hasPassword,
    }
  }

  /**
   * 载入完整配置（含密码）构造 NacosClient；未配置完整时返回 null。
   */
  async buildClient(opts: { fetchImpl?: typeof fetch } = {}): Promise<NacosClient | null> {
    const serverUrl = this.readString('server-url')
    const namespace = this.readString('namespace') || 'public'
    const username = this.readString('username')
    const password = await keystore.getSecret(passwordRef())
    if (!serverUrl || !username || !password) return null
    return new NacosClient({
      serverUrl,
      namespace,
      username,
      password,
      ...opts,
    })
  }

  /** 保存配置；密码仅在显式传入时更新（不传保留旧值，空串清除） */
  async save(input: TeamRegistryConfigInput): Promise<TeamRegistryConfigSnapshot> {
    const serverUrl = input.serverUrl.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//.test(serverUrl)) {
      throw new Error('团队注册中心地址必须以 http:// 或 https:// 开头')
    }
    const namespace = input.namespace.trim() || 'public'
    const username = input.username.trim()
    if (!username) throw new Error('团队注册中心账号不能为空')
    this.settings.set(TEAM_REGISTRY_SETTINGS_CATEGORY, 'server-url', serverUrl)
    this.settings.set(TEAM_REGISTRY_SETTINGS_CATEGORY, 'namespace', namespace)
    this.settings.set(TEAM_REGISTRY_SETTINGS_CATEGORY, 'username', username)
    if (input.password !== undefined) {
      if (input.password === '') {
        await keystore.deleteSecret(passwordRef())
      } else {
        await keystore.setSecret(passwordRef(), input.password)
      }
    }
    return this.getSnapshot()
  }

  /** 用「未保存的表单值」直接测试连接（保存前预检），全部字段必填 */
  async testConnectionWith(
    input: { serverUrl: string; namespace: string; username: string; password: string },
  ): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    const client = new NacosClient({
      serverUrl: input.serverUrl.trim().replace(/\/+$/, ''),
      namespace: input.namespace.trim() || 'public',
      username: input.username.trim(),
      password: input.password,
    })
    return client.testRoundTrip()
  }

  /** 用已保存配置测试连接 */
  async testSavedConnection(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    const client = await this.buildClient()
    if (!client) {
      return { healthy: false, latencyMs: 0, error: '团队注册中心尚未配置完整（地址/账号/密码）' }
    }
    return client.testRoundTrip()
  }

  /** 清空全部配置（含密码） */
  async clear(): Promise<void> {
    this.settings.deleteByCategory(TEAM_REGISTRY_SETTINGS_CATEGORY)
    await keystore.deleteSecret(passwordRef())
  }

  /** 当前配置的命名空间（默认 public） */
  readNamespace(): string {
    return this.readString('namespace') || 'public'
  }

  private readString(key: string): string {
    const value = this.settings.get(TEAM_REGISTRY_SETTINGS_CATEGORY, key)
    return typeof value === 'string' ? value : ''
  }
}
