import { describe, expect, it } from 'vitest'
import {
  NACOS_MCP_PROTOCOL,
  buildMcpDraftFields,
  sensitiveConfigKeys,
  specToLocalConfigJson,
} from './mcp-mapping.js'

describe('team-registry mcp-mapping', () => {
  it('stdio config → draft fields（localServerConfig 承载 command/args/env，无 endpointSpecification）', () => {
    const fields = buildMcpDraftFields({
      mcpName: 'my-server',
      version: '1.2.3',
      namespaceId: 'public',
      configJson: JSON.stringify({
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-echo'],
        env: { FOO: 'bar' },
      }),
      description: '测试服务',
    })
    expect(fields.mcpName).toBe('my-server')
    expect(fields.version).toBe('1.2.3')
    expect(fields.namespaceId).toBe('public')
    expect(fields.endpointSpecification).toBeUndefined()
    const spec = JSON.parse(fields.serverSpecification) as Record<string, unknown>
    expect(spec.protocol).toBe(NACOS_MCP_PROTOCOL.stdio)
    expect(spec.frontProtocol).toBe(NACOS_MCP_PROTOCOL.stdio)
    expect(spec.version).toBe('1.2.3')
    expect(spec.localServerConfig).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-echo'],
      env: { FOO: 'bar' },
    })
    expect(spec.remoteServerConfig).toBeNull()
  })

  it('http config → 远程型（DIRECT endpointSpecification + exportPath）', () => {
    const fields = buildMcpDraftFields({
      mcpName: 'remote-svc',
      version: '0.1.0',
      namespaceId: 'public',
      configJson: JSON.stringify({ transport: 'http', url: 'https://10.0.0.3:8443/api/mcp?x=1' }),
    })
    const endpoint = JSON.parse(fields.endpointSpecification!) as {
      type: string
      data: { transportProtocol: string; address: string; port: string }
    }
    expect(endpoint.type).toBe('DIRECT')
    expect(endpoint.data).toEqual({
      transportProtocol: 'https',
      address: '10.0.0.3',
      port: '8443',
    })
    const spec = JSON.parse(fields.serverSpecification) as Record<string, unknown>
    expect(spec.protocol).toBe(NACOS_MCP_PROTOCOL.streamableHttp)
    expect(spec.remoteServerConfig).toEqual({ exportPath: '/api/mcp?x=1' })
    expect(spec.localServerConfig).toBeNull()
  })

  it('spec → 本地 config（stdio 往返）', () => {
    const spec = {
      name: 'my-server',
      version: '1.0.0',
      protocol: 'stdio',
      localServerConfig: { command: 'node', args: ['server.js'], env: { A: 'b' } },
      remoteServerConfig: null,
    }
    const configJson = specToLocalConfigJson(spec)
    expect(configJson).not.toBeNull()
    expect(JSON.parse(configJson!)).toEqual({
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { A: 'b' },
    })
  })

  it('spec → 本地 config（远程 DIRECT 往返，还原 url）', () => {
    const spec = {
      protocol: 'mcp-streamable-http',
      remoteServerConfig: { exportPath: '/mcp' },
      endpointSpecification: {
        type: 'DIRECT',
        data: { transportProtocol: 'http', address: '10.0.0.3', port: '8080' },
      },
    }
    const configJson = specToLocalConfigJson(spec)
    expect(configJson).not.toBeNull()
    expect(JSON.parse(configJson!)).toEqual({ transport: 'http', url: 'http://10.0.0.3:8080/mcp' })
  })

  it('sse spec → sse 传输；stdio 缺 command 返回 null', () => {
    const sse = specToLocalConfigJson({
      protocol: 'sse',
      remoteServerConfig: { exportPath: '/sse' },
      endpointSpecification: {
        type: 'DIRECT',
        data: { transportProtocol: 'http', address: 'h', port: '80' },
      },
    })
    expect(JSON.parse(sse!)).toEqual({ transport: 'sse', url: 'http://h/sse' })
    expect(specToLocalConfigJson({ protocol: 'stdio', localServerConfig: {} })).toBeNull()
    expect(specToLocalConfigJson(null)).toBeNull()
  })

  it('sensitiveConfigKeys 只报敏感键名不报值', () => {
    const keys = sensitiveConfigKeys({
      env: { GITHUB_TOKEN: 'x', HOME: '/home/me' },
      headers: { Authorization: 'Bearer x', 'X-Trace': 'y' },
    })
    expect(keys).toContain('GITHUB_TOKEN')
    expect(keys).toContain('Authorization')
    expect(keys).not.toContain('HOME')
    expect(keys).not.toContain('X-Trace')
  })

  it('非法 config_json 抛错', () => {
    expect(() =>
      buildMcpDraftFields({
        mcpName: 'x',
        version: '1.0.0',
        namespaceId: 'public',
        configJson: 'not-json',
      }),
    ).toThrow(/JSON/)
  })
})
