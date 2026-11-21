/**
 * 市场目录层:按设计 asset-market.md 第三节实现取件顺序的目录部分。
 *
 * 本轮落地的步骤:取来源元数据(1)→ 取合集证书(2,三档,3.2)→ 在插件内校验证书链(3,
 * 复用 verifySourceTrust)→ 取包列表(7)。取件结果按 3.4 两轴记录:签名结论与来源结论
 * 互不替代,随目录结果一起返回,每次重新计算,不采信旧值。
 *
 * 尚未接入的部分:分发模型识别与清单验签(4、5、6)。两个内置合集当前都没有发布
 * 带签名的清单材料,接了也没有可验的对象,因此本轮签名结论恒为未校验;结构上保留
 * 三态取值,清单验签落地后直接复用。这个缺口只影响结论展示,不影响目录与安装。
 *
 * 失败口径(3.5、6.1):除「宿主没有读取通道」之外,任何一步失败都不阻断浏览,只降级
 * 结论——拿不到证书时来源结论判为未通过(证书缺失),目录仍展示;assets.json 不可读时
 * 目录为空并提示索引不可读;来源所有地址都不可达时整个来源失败,不影响其他来源。
 */
import { verifySourceTrust } from '../trust/source-verdict.js'
import type { AssetTextTransport } from '../humanize/types.js'
import type { MarketSource } from './sources.js'

/** 市场取件的错误码:目录层与安装层共用 */
export type MarketErrorCode =
  | 'transport-missing'
  | 'source-unreachable'
  | 'source-unknown'
  | 'source-disabled'

/** 市场取件错误;不抛错,由调用方决定降级方式 */
export interface MarketError {
  code: MarketErrorCode
  message: string
}

/** assets.json 里的一条包目录项(8.2:顶层数组,字段为包标识、作者、标签、类型集合) */
export interface CatalogPackageEntry {
  /** 包标识,与包内 asset.json 的 id 一致 */
  readonly id: string
  /** 作者,同时是包目录的上一层目录名 */
  readonly author: string
  /** 标签,合集侧叫 tag */
  readonly tags: readonly string[]
  /** 包声明的类型集合 */
  readonly types: readonly string[]
}

/** 来源元数据的兼容读取结果(8.2:两种 meta 形状都认,统一由合集侧决定,市场不猜) */
export interface CatalogMeta {
  /** flat 是 assetSpecVersion/assetFormatVersion 形状,indexed 是 name/indexVersion/assetFormat 形状 */
  readonly shape: 'flat' | 'indexed' | 'unknown'
  readonly specVersion?: string
  readonly formatVersion?: string
  readonly name?: string
  readonly indexVersion?: string
}

/** 目录取件的两轴结论(3.4);签名结论本轮恒为未校验,来源结论只由链校验给出 */
export interface CatalogTrust {
  readonly signature: 'passed' | 'unverified' | 'failed'
  readonly source: 'confirmed' | 'rejected' | 'unconfirmable' | 'local'
  readonly sourceReason?: string
}

/** 一次目录取件的结果 */
export type CatalogResult =
  | {
      ok: true
      /** 合集 id */
      sourceId: string
      /** 本次实际生效的 base_url;后续取件(安装)必须同址(3.1 约束) */
      baseUrl: string
      meta: CatalogMeta
      packages: readonly CatalogPackageEntry[]
      trust: CatalogTrust
      notes: readonly string[]
    }
  | { ok: false; error: MarketError }

/** 证书的三档地址(3.2);都相对生效的 base_url,不跨地址拼材料 */
const CERT_TIERS = (collectionId: string): readonly string[] => [
  'certs/' + collectionId + '/' + collectionId + '-eec.crt',
  'certs/' + collectionId + '-eec.crt',
  'eec.pem',
]

/** 读取一次文本;transport 的失败一律转成 null,由调用方按步骤口径降级 */
const readTextOrNull = async (transport: AssetTextTransport, url: string): Promise<string | null> => {
  try {
    return await transport.readText(url)
  } catch {
    return null
  }
}

/**
 * 兼容读取来源元数据的两种形状(8.2):
 * - flat(awesome 侧):assetSpecVersion 与 assetFormatVersion;
 * - indexed(inner 侧):name、indexVersion 与嵌套的 assetFormat。
 * 两种特征都不成立时 shape 记为 unknown,目录照常取件,字段是否统一属合集侧变更。
 */
export const readCatalogMeta = (value: unknown): CatalogMeta => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { shape: 'unknown' }
  }
  const raw = value as Record<string, unknown>
  const spec = raw.assetSpecVersion
  const format = raw.assetFormatVersion
  if (typeof spec === 'string' && spec !== '' && typeof format === 'string' && format !== '') {
    return { shape: 'flat', specVersion: spec, formatVersion: format }
  }
  const name = raw.name
  const indexVersion = raw.indexVersion
  const assetFormat = raw.assetFormat
  if (
    typeof name === 'string' && name !== '' &&
    typeof indexVersion === 'string' && indexVersion !== '' &&
    typeof assetFormat === 'object' && assetFormat !== null && !Array.isArray(assetFormat)
  ) {
    const nested = assetFormat as Record<string, unknown>
    const nestedSpec = nested.specVersion
    const nestedFormat = nested.formatVersion
    return {
      shape: 'indexed',
      name,
      indexVersion,
      ...(typeof nestedSpec === 'string' ? { specVersion: nestedSpec } : {}),
      ...(typeof nestedFormat === 'string' ? { formatVersion: nestedFormat } : {}),
    }
  }
  return { shape: 'unknown' }
}

/** assets.json 的一条原始项;tag 是合集侧的字段名,types 是类型集合 */
const readPackageEntry = (value: unknown): CatalogPackageEntry | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const id = raw.id
  const author = raw.author
  if (typeof id !== 'string' || id === '' || typeof author !== 'string' || author === '') return null

  const tags: string[] = []
  if (raw.tag !== undefined) {
    if (!Array.isArray(raw.tag) || !raw.tag.every((item) => typeof item === 'string')) return null
    tags.push(...(raw.tag as string[]))
  }
  const types: string[] = []
  if (raw.types !== undefined) {
    if (!Array.isArray(raw.types) || !raw.types.every((item) => typeof item === 'string')) return null
    types.push(...(raw.types as string[]))
  }
  return { id, author, tags, types }
}

/**
 * 对一个来源执行目录取件。
 *
 * base_url 按顺序尝试(3.1 第 1 步):meta.json 在某个地址取到后,证书与索引都只从
 * 该地址取(同一来源的信任材料必须同址,3.1 约束)。证书按三档地址依次尝试,
 * 三档都拿不到时来源结论判为未通过(证书缺失),目录仍展示;链校验复用
 * verifySourceTrust,链不通过时不再有验签步骤可发起,来源结论判为未通过。
 */
export const fetchCatalog = async (options: {
  source: MarketSource
  transport: AssetTextTransport | null
  /** 校验时刻;缺省取当前时间,测试用它构造过期反例 */
  now?: Date
}): Promise<CatalogResult> => {
  const { source, transport, now } = options
  if (transport === null) {
    return {
      ok: false,
      error: { code: 'transport-missing', message: '当前宿主未提供远端读取通道(assets:read),无法取件' },
    }
  }
  if (!source.enabled) {
    return {
      ok: false,
      error: { code: 'source-disabled', message: '来源已被关闭,不发起任何请求: ' + source.id },
    }
  }

  const notes: string[] = []
  let baseUrl: string | null = null
  let meta: CatalogMeta = { shape: 'unknown' }

  // 第 1 步:取来源元数据,全部地址都失败即来源不可达
  for (const candidate of source.baseUrls) {
    const text = await readTextOrNull(transport, candidate + 'meta.json')
    if (text === null) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      // 元数据不是合法 JSON 属「读不了」的边缘:换下一个地址,全部失败按不可达处理
      continue
    }
    baseUrl = candidate
    meta = readCatalogMeta(parsed)
    break
  }
  if (baseUrl === null) {
    return {
      ok: false,
      error: {
        code: 'source-unreachable',
        message: '该来源的所有地址都无法访问: ' + source.id,
      },
    }
  }

  // 第 2、3 步:取合集证书并校验链;拿不到证书只降级来源结论,目录仍展示
  let certPem: string | null = null
  for (const tier of CERT_TIERS(source.id)) {
    const text = await readTextOrNull(transport, baseUrl + tier)
    if (text === null) continue
    certPem = text
    break
  }

  let trust: CatalogTrust
  if (certPem === null) {
    trust = { signature: 'unverified', source: 'rejected', sourceReason: '证书缺失' }
    notes.push('来源证书缺失,来源结论按未通过处理,目录照常展示')
  } else {
    const verdict = await verifySourceTrust(
      source.id,
      now === undefined ? { sourceCertPem: certPem } : { sourceCertPem: certPem, now },
    )
    trust = {
      signature: verdict.signature,
      source: verdict.source,
      ...(verdict.sourceReason === undefined ? {} : { sourceReason: verdict.sourceReason }),
    }
    if (verdict.source === 'rejected') {
      notes.push('来源证书校验未通过: ' + (verdict.sourceReason ?? ''))
    }
  }

  // 第 7 步:取包列表;结构不符时目录为空并提示索引不可读
  let packages: CatalogPackageEntry[] = []
  const indexText = await readTextOrNull(transport, baseUrl + 'assets.json')
  if (indexText === null) {
    notes.push('资产索引不可读')
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(indexText) as unknown
    } catch {
      parsed = null
    }
    if (!Array.isArray(parsed)) {
      notes.push('资产索引不可读')
    } else {
      let malformed = false
      for (const item of parsed) {
        const entry = readPackageEntry(item)
        if (entry === null) {
          malformed = true
          break
        }
        packages.push(entry)
      }
      if (malformed) {
        packages = []
        notes.push('资产索引不可读')
      }
    }
  }

  if (meta.shape === 'unknown') {
    notes.push('来源元数据的形状不在已知的两种之内,按兼容读取处理,字段统一由合集侧决定')
  }
  notes.push('清单签名验签未接入,签名结论按未校验处理')

  return {
    ok: true,
    sourceId: source.id,
    baseUrl,
    meta,
    packages,
    trust,
    notes,
  }
}
