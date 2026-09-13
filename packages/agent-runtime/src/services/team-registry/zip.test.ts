import { describe, expect, it } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { buildZip, readZip } from './zip.js'

describe('team-registry zip（STORE 构造 + STORE/DEFLATE 解析）', () => {
  it('单文件构造 → 解析 roundtrip 内容一致', () => {
    const zip = buildZip([
      { path: 'SKILL.md', content: Buffer.from('---\nname: demo\n---\nbody', 'utf-8') },
    ])
    const entries = readZip(zip)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.path).toBe('SKILL.md')
    expect(entries[0]!.content.toString('utf-8')).toBe('---\nname: demo\n---\nbody')
  })

  it('多文件 + 子目录 + 中文文件名 roundtrip', () => {
    const files = [
      { path: 'SKILL.md', content: Buffer.from('# skill', 'utf-8') },
      { path: 'references/guide.md', content: Buffer.from('指南内容', 'utf-8') },
      { path: 'scripts/中文脚本.md', content: Buffer.from('中文内容 ✓', 'utf-8') },
    ]
    const entries = readZip(buildZip(files))
    expect(entries.map((e) => e.path)).toEqual(files.map((f) => f.path))
    expect(entries.map((e) => e.content.toString('utf-8'))).toEqual(
      files.map((f) => f.content.toString('utf-8')),
    )
  })

  it('确定性：同一输入两次构造 byte 级一致', () => {
    const files = [
      { path: 'a.txt', content: Buffer.from('x') },
      { path: 'b/c.txt', content: Buffer.from('y') },
    ]
    expect(Buffer.compare(buildZip(files), buildZip(files))).toBe(0)
  })

  it('解析 DEFLATE 条目（第三方打包方常见形态）', () => {
    // 手工构造 method=8 的最小 zip：local header + deflate 数据 + central + EOCD
    const name = Buffer.from('deflated.txt', 'utf-8')
    const raw = Buffer.from('deflate me '.repeat(20), 'utf-8')
    const data = deflateRawSync(raw)
    const crc = crc32Of(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8) // DEFLATE
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(0, 42) // local offset

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(1, 8)
    eocd.writeUInt16LE(1, 10)
    eocd.writeUInt32LE(central.length + name.length, 12)
    eocd.writeUInt32LE(30 + name.length + data.length, 16)

    const zip = Buffer.concat([local, name, data, central, name, eocd])
    const entries = readZip(zip)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.path).toBe('deflated.txt')
    expect(entries[0]!.content.toString('utf-8')).toBe(raw.toString('utf-8'))
  })

  it('路径逃逸防御：绝对路径 / .. / 反斜杠拒绝', () => {
    expect(() => buildZip([{ path: '../evil.txt', content: Buffer.from('x') }])).toThrow(/逃逸|非法/)
    expect(() => buildZip([{ path: '/abs.txt', content: Buffer.from('x') }])).toThrow(/逃逸|非法/)
    expect(() => buildZip([{ path: 'a\\b.txt', content: Buffer.from('x') }])).toThrow(/逃逸|非法/)
  })

  it('空条目与非 zip 输入报错', () => {
    expect(() => buildZip([])).toThrow(/至少/)
    expect(() => readZip(Buffer.from('not a zip'))).toThrow(/End of Central Directory/)
  })
})

function crc32Of(buf: Buffer): number {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
