/**
 * @module team-registry/zip
 *
 * 最小 zip 实现（零依赖）——团队注册中心技能推拉专用
 *
 * 背景：Nacos AI Skill 原生 API 以 zip 为包格式（upload 收 zip、download 回 zip），
 * 而仓库没有 zip 依赖。技能载荷是受控文本（发布前已按 TEAM_ASSET_LIMITS 限流），
 * 因此构造侧用 STORE（不压缩）模式即可；解析侧同时支持 STORE 与 DEFLATE
 * （服务端/他人上传的包可能是压缩模式，用 node:zlib inflateRawSync 解）。
 *
 * 确定性：条目按传入顺序、固定 DOS 时间戳写入，同一文件树多次构造 byte 级一致
 * （测试与调试依赖这一点）。
 */

import { inflateRawSync } from 'node:zlib'

export interface ZipEntryInput {
  /** posix 风格相对路径（正斜杠，不允许 ..、不允许绝对路径） */
  path: string
  content: Buffer
}

const LOCAL_HEADER_SIG = 0x04034b50
const CENTRAL_HEADER_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

/** UTF-8 文件名标志（bit 11） */
const FLAG_UTF8 = 0x0800
/** 固定 DOS 时间（1980-01-01 00:00:00），保证输出确定性 */
const DOS_TIME = 0
const DOS_DATE = 0x0021

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

// ─── CRC32 ──────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ─── 构造（STORE 模式） ─────────────────────────────────────────────────

function assertSafePath(path: string): void {
  if (!path || path.length > 65535) throw new Error(`zip 条目路径非法：${JSON.stringify(path)}`)
  if (path.includes('\\') || path.includes('..') || path.startsWith('/')) {
    throw new Error(`zip 条目路径不允许逃逸：${path}`)
  }
}

/** 构造 zip（STORE 模式，确定性输出） */
export function buildZip(entries: ZipEntryInput[]): Buffer {
  if (entries.length === 0) throw new Error('zip 至少需要一个条目')
  if (entries.length > 65535) throw new Error('zip 条目数超上限 65535')

  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    assertSafePath(entry.path)
    const name = Buffer.from(entry.path, 'utf-8')
    const crc = crc32(entry.content)
    const size = entry.content.length
    if (size > 0xffffffff) throw new Error(`zip 条目过大：${entry.path}`)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_HEADER_SIG, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(FLAG_UTF8, 6)
    local.writeUInt16LE(METHOD_STORE, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18) // compressed
    local.writeUInt32LE(size, 22) // uncompressed
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra len
    localParts.push(local, name, entry.content)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_HEADER_SIG, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(FLAG_UTF8, 8)
    central.writeUInt16LE(METHOD_STORE, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra len
    central.writeUInt16LE(0, 32) // comment len
    central.writeUInt16LE(0, 34) // disk number
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)

    offset += 30 + name.length + size
  }

  const centralBuf = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // comment len

  return Buffer.concat([...localParts, centralBuf, eocd])
}

/**
 * 剥离公共顶层目录：Nacos 服务端下载的 zip 会包一层 `<skillName>/` 目录
 * （2026-09-11 真机实测），本地技能目录是平铺的。当且仅当全部条目共享同一
 * 首段时剥掉该段（平铺包不受影响）。
 */
export function stripZipCommonRoot(entries: ZipEntryOutput[]): ZipEntryOutput[] {
  if (entries.length === 0) return entries
  const first = entries[0]!.path
  const slash = first.indexOf('/')
  if (slash <= 0) return entries
  const prefix = first.slice(0, slash + 1)
  const allPrefixed = entries.every((e) => e.path.startsWith(prefix))
  if (!allPrefixed) return entries
  return entries.map((e) => ({ path: e.path.slice(prefix.length), content: e.content }))
}

// ─── 解析（STORE + DEFLATE） ────────────────────────────────────────────

export interface ZipEntryOutput {
  path: string
  content: Buffer
}

/**
 * 解析 zip 为条目列表（跳过目录条目）。
 * 通过 EOCD 定位 central directory，再按 local header 取数据（local 与 central
 * 的 name/extra 长度可能不一致，必须分别读取）。
 */
export function readZip(buf: Buffer): ZipEntryOutput[] {
  const eocdOffset = locateEocd(buf)
  const entryCount = buf.readUInt16LE(eocdOffset + 10)
  const centralOffset = buf.readUInt32LE(eocdOffset + 16)

  const out: ZipEntryOutput[] = []
  let p = centralOffset
  for (let i = 0; i < entryCount; i += 1) {
    if (buf.readUInt32LE(p) !== CENTRAL_HEADER_SIG) {
      throw new Error(`zip central directory 损坏（offset ${p}）`)
    }
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf-8')
    p += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/')) continue // 目录条目
    assertSafePath(name)

    // local header：数据区起点 = localOffset + 30 + localNameLen + localExtraLen
    if (buf.readUInt32LE(localOffset) !== LOCAL_HEADER_SIG) {
      throw new Error(`zip local header 损坏（offset ${localOffset}）`)
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const raw = buf.slice(dataStart, dataStart + compressedSize)

    let content: Buffer
    if (method === METHOD_STORE) {
      content = Buffer.from(raw)
    } else if (method === METHOD_DEFLATE) {
      content = inflateRawSync(raw)
    } else {
      throw new Error(`不支持的 zip 压缩方法 ${method}（条目：${name}）`)
    }
    out.push({ path: name, content })
  }
  return out
}

/** 从尾部向前扫 EOCD 签名（容忍少量注释字节） */
function locateEocd(buf: Buffer): number {
  const minEocd = 22
  const maxScan = Math.min(buf.length, minEocd + 65535)
  for (let i = buf.length - minEocd; i >= buf.length - maxScan; i -= 1) {
    if (i < 0) break
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  throw new Error('zip 缺少 End of Central Directory（不是合法 zip）')
}
