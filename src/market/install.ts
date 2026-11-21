/**
 * 市场安装取件层:按设计 asset-market.md 第 3.1 第 9-11 步与第四节实现包目录取件。
 *
 * 安装一次取包 = 按包层清单(L3 manifest.json)列出的路径逐个取文件(第 11 步),
 * 逐文件过 transport,与清单登记的 SHA-512 比对,再按「asset.json 原样放进 metadata、
 * 类型目录条目按类型分组成数组放进 contents」的口径扁平化成加载期包文档,
 * 交给 importAssetPackage 做整包校验与原子装配(既有语义,见 src/index.ts)。
 *
 * 原子性(4.3):取件阶段任何一步失败都不落盘——不调用 importAssetPackage,
 * 已有装配内容与安装记录保持不变;整包校验失败时 importAssetPackage 自身整包拒绝。
 *
 * 同址约束(3.1):安装取件沿用目录取件时实际生效的 base_url,调用方从
 * fetchCatalog 的结果里把 baseUrl 传进来,不在安装时重新挑地址。
 */
import { CONTENT_TYPES } from '../humanize/types.js'
import type { AssetTextTransport, ContentType } from '../humanize/types.js'

/** 包层清单里的一条文件登记 */
export interface L3FileEntry {
  /** 相对包目录的路径,如 0.1.1/asset.json */
  readonly path: string
  /** 该文件的 SHA-512,十六进制;清单未登记时不比对 */
  readonly sha512?: string
}

/** 包层清单(L3 manifest.json)的形状;schemaVersion 与 revision 原样保留进安装记录 */
export interface L3Manifest {
  readonly schemaVersion?: number
  readonly revision?: number
  readonly files: readonly L3FileEntry[]
}

/** versions.json 的形状(第 10 步:取版本信息) */
export interface PackageVersions {
  readonly latest?: string
  readonly versions: readonly string[]
}

/** 安装取件的错误码;除 transport-missing 外全部整包拒绝,不落盘 */
export type InstallFetchErrorCode =
  | 'transport-missing'
  | 'manifest-missing'
  | 'version-unknown'
  | 'package-unreachable'
  | 'hash-mismatch'
  | 'invalid-package-document'

/** 安装取件错误;code 供界面区分「读不了」与「不可达」 */
export type InstallFetchError = {
  code: InstallFetchErrorCode
  message: string
}

/** 安装取件结果:成功给出扁平化后的加载期包文档与清单修订号 */
export type PackageFetchResult =
  | {
      ok: true
      /** 加载期包文档:metadata 是 asset.json,contents 按类型分组 */
      document: { metadata: unknown; contents: Record<string, unknown[]> }
      /** 包层清单的 revision,进安装记录供回退提示 */
      revision?: number
      /** 本次取到的文件路径,按清单顺序 */
      files: readonly string[]
    }
  | { ok: false; error: InstallFetchError }

const PACKAGE_DIR = (baseUrl: string, author: string, packageId: string): string =>
  baseUrl + 'assets/' + encodeURIComponent(author) + '/' + encodeURIComponent(packageId) + '/'

const readTextOrNull = async (transport: AssetTextTransport, url: string): Promise<string | null> => {
  try {
    return await transport.readText(url)
  } catch {
    return null
  }
}

/** 清单文件条目的形状校验:path 必填且不带 .. 与绝对路径,sha512 出现时必须是 128 位十六进制 */
const readL3FileEntry = (value: unknown): L3FileEntry | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const path = raw.path
  if (typeof path !== 'string' || path === '' || path.startsWith('/') || path.includes('..')) return null
  const sha512 = raw.sha512
  if (sha512 !== undefined && !(typeof sha512 === 'string' && /^[0-9a-f]{128}$/.test(sha512))) return null
  return { path, ...(sha512 === undefined ? {} : { sha512 }) }
}

/** 包层清单的形状校验:files 必须是数组,条目逐个收敛 */
const readL3Manifest = (value: unknown): L3Manifest | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const filesRaw = raw.files
  if (!Array.isArray(filesRaw)) return null
  const files: L3FileEntry[] = []
  for (const item of filesRaw) {
    const entry = readL3FileEntry(item)
    if (entry === null) return null
    files.push(entry)
  }
  const schemaVersion = raw.schemaVersion
  const revision = raw.revision
  return {
    ...(typeof schemaVersion === 'number' ? { schemaVersion } : {}),
    ...(typeof revision === 'number' ? { revision } : {}),
    files,
  }
}

/** versions.json 的形状校验:latest 与 versions 至少出现一个,且都是文本 */
const readPackageVersions = (value: unknown): PackageVersions | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const latest = raw.latest
  const versionsRaw = raw.versions
  if (latest !== undefined && typeof latest !== 'string') return null
  if (versionsRaw !== undefined) {
    if (!Array.isArray(versionsRaw) || !versionsRaw.every((item) => typeof item === 'string')) return null
  } else if (latest === undefined) {
    return null
  }
  return {
    ...(typeof latest === 'string' ? { latest } : {}),
    versions: versionsRaw === undefined ? [] : (versionsRaw as string[]),
  }
}

const CONTENT_TYPE_SET: ReadonlySet<string> = new Set(CONTENT_TYPES)

/** SHA-512 十六进制摘要;浏览器与 Node 都走 WebCrypto,不引入依赖 */
const sha512Hex = async (text: string): Promise<string> => {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-512', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * 取一个版本的包内全部文件并扁平化成加载期包文档。
 *
 * 流程:取包层清单(缺失即整包拒绝,没有清单就没有可信的文件列表,无法安全取件)
 * → 取 versions.json 解析目标版本(显式给版本时仍要确认它在版本列表里,列表不可读
 * 或不含该版本都拒绝)→ 从清单里筛出该版本的文件 → 逐文件经 transport 取文本,
 * 清单登记了 SHA-512 的文件逐一比对,不一致即哈希失败,整包拒绝 → asset.json 必在
 * 且声明与取到的包标识、版本一致 → 类型目录下的条目按类型分组成 contents,
 * 类型目录之外的文件(README 等)不进入文档。
 */
export const fetchPackageDocument = async (options: {
  /** 目录取件时实际生效的 base_url,含尾部斜杠 */
  baseUrl: string
  author: string
  packageId: string
  /** 目标版本;缺省取 versions.json 的 latest */
  version?: string
  transport: AssetTextTransport | null
}): Promise<PackageFetchResult> => {
  const { baseUrl, author, packageId, version, transport } = options
  if (transport === null) {
    return {
      ok: false,
      error: { code: 'transport-missing', message: '当前宿主未提供远端读取通道(assets:read),无法取件' },
    }
  }

  const dir = PACKAGE_DIR(baseUrl, author, packageId)

  // 第 9 步:取包层清单;没有清单就没有可信的文件列表,整包拒绝
  const manifestText = await readTextOrNull(transport, dir + 'manifest.json')
  if (manifestText === null) {
    return {
      ok: false,
      error: { code: 'manifest-missing', message: '包层清单缺失,无法安全取件: ' + packageId },
    }
  }
  let manifestJson: unknown
  try {
    manifestJson = JSON.parse(manifestText) as unknown
  } catch {
    return {
      ok: false,
      error: { code: 'manifest-missing', message: '包层清单不是合法 JSON,整包拒绝: ' + packageId },
    }
  }
  const manifest = readL3Manifest(manifestJson)
  if (manifest === null) {
    return {
      ok: false,
      error: { code: 'manifest-missing', message: '包层清单结构不符,整包拒绝: ' + packageId },
    }
  }

  // 第 10 步:取版本信息,解析目标版本
  let targetVersion = version
  if (targetVersion === undefined) {
    const versionsText = await readTextOrNull(transport, dir + 'versions.json')
    if (versionsText === null) {
      return {
        ok: false,
        error: { code: 'version-unknown', message: '取不到版本信息,无法确定要安装的版本: ' + packageId },
      }
    }
    let versionsJson: unknown
    try {
      versionsJson = JSON.parse(versionsText) as unknown
    } catch {
      return {
        ok: false,
        error: { code: 'version-unknown', message: '版本信息不是合法 JSON,无法确定要安装的版本: ' + packageId },
      }
    }
    const versions = readPackageVersions(versionsJson)
    if (versions === null || versions.latest === undefined) {
      return {
        ok: false,
        error: { code: 'version-unknown', message: '版本信息里没有 latest,无法确定要安装的版本: ' + packageId },
      }
    }
    targetVersion = versions.latest
  } else {
    const versionsText = await readTextOrNull(transport, dir + 'versions.json')
    if (versionsText !== null) {
      try {
        const versions = readPackageVersions(JSON.parse(versionsText) as unknown)
        if (versions !== null && versions.versions.length > 0 && !versions.versions.includes(targetVersion)) {
          return {
            ok: false,
            error: { code: 'version-unknown', message: '该来源不分发版本 ' + targetVersion + ': ' + packageId },
          }
        }
      } catch {
        // versions.json 不可读不阻断显式版本安装:目录层按清单文件判定
      }
    }
  }

  // 第 11 步:按清单取该版本的全部文件
  const prefix = targetVersion + '/'
  const selected = manifest.files.filter((entry) => entry.path.startsWith(prefix))
  const hasAssetJson = selected.some((entry) => entry.path === prefix + 'asset.json')
  if (!hasAssetJson) {
    return {
      ok: false,
      error: { code: 'invalid-package-document', message: '包层清单没有列出 ' + targetVersion + '/asset.json,整包拒绝: ' + packageId },
    }
  }

  const fetched = new Map<string, string>()
  for (const entry of selected) {
    const url = dir + entry.path
    const text = await readTextOrNull(transport, url)
    if (text === null) {
      return {
        ok: false,
        error: { code: 'package-unreachable', message: '包内文件取不到,整包拒绝: ' + entry.path },
      }
    }
    if (entry.sha512 !== undefined) {
      const actual = await sha512Hex(text)
      if (actual !== entry.sha512.toLowerCase()) {
        return {
          ok: false,
          error: { code: 'hash-mismatch', message: '包内文件与清单登记的哈希不一致,整包拒绝: ' + entry.path },
        }
      }
    }
    fetched.set(entry.path, text)
  }

  // 扁平化:asset.json 原样放进 metadata,类型目录条目按类型分组成 contents
  const assetJsonText = fetched.get(prefix + 'asset.json')
  if (assetJsonText === undefined) {
    return {
      ok: false,
      error: { code: 'invalid-package-document', message: '取不到 asset.json,整包拒绝: ' + packageId },
    }
  }
  let metadata: unknown
  try {
    metadata = JSON.parse(assetJsonText) as unknown
  } catch {
    return {
      ok: false,
      error: { code: 'invalid-package-document', message: 'asset.json 不是合法 JSON,整包拒绝: ' + packageId },
    }
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return {
      ok: false,
      error: { code: 'invalid-package-document', message: 'asset.json 必须是对象,整包拒绝: ' + packageId },
    }
  }
  const metaRaw = metadata as Record<string, unknown>
  if (metaRaw.id !== packageId) {
    return {
      ok: false,
      error: { code: 'invalid-package-document', message: 'asset.json 的 id 与请求的包标识不一致: ' + String(metaRaw.id) },
    }
  }
  if (metaRaw.version !== targetVersion) {
    return {
      ok: false,
      error: { code: 'invalid-package-document', message: 'asset.json 的 version 与请求的版本不一致: ' + String(metaRaw.version) },
    }
  }

  const contents: Record<string, unknown[]> = {}
  for (const [path, text] of fetched) {
    if (path === prefix + 'asset.json') continue
    const rest = path.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash <= 0) continue
    const typeDir = rest.slice(0, slash)
    if (!CONTENT_TYPE_SET.has(typeDir)) continue
    let item: unknown
    try {
      item = JSON.parse(text) as unknown
    } catch {
      return {
        ok: false,
        error: { code: 'invalid-package-document', message: '包内条目不是合法 JSON,整包拒绝: ' + path },
      }
    }
    const bucket = contents[typeDir] ?? []
    bucket.push(item)
    contents[typeDir] = bucket
  }

  return {
    ok: true,
    document: { metadata, contents },
    ...(manifest.revision === undefined ? {} : { revision: manifest.revision }),
    files: selected.map((entry) => entry.path),
  }
}

/** 版本目录下的类型目录名是否属于五类内容;扁平化只收这五类 */
export const isContentTypeDir = (name: string): name is ContentType => CONTENT_TYPE_SET.has(name)
