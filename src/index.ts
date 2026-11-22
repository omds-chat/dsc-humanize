import { createBeforeRequestHandler } from './host/request-patch.js'
import { openSnapshotStore } from './host/snapshot-db.js'
import type { SnapshotStore } from './host/snapshot-db.js'
import { SNAPSHOT_STORAGE_KEY, createSnapshot, readActiveSnapshot } from './host/snapshot.js'
import { readAssetPackage } from './humanize/assets/loader.js'
import { KERNEL_VERSION } from './humanize/index.js'
import type { AssetContents, AssetLoadError, AssetPackage, AssetTextTransport } from './humanize/types.js'
import { fetchCatalog } from './market/catalog.js'
import type { CatalogResult, CatalogTrust, MarketError } from './market/catalog.js'
import { fetchPackageDocument } from './market/install.js'
import type { InstallFetchError } from './market/install.js'
import { marketSettingDescriptor, resolveMarketSources } from './market/sources.js'
import {
  buildMarketPageModel,
  CATALOG_CACHE_TTL_MS,
  INSTALL_ACTION_KEY,
  MARKET_SLOT,
  MARKET_SLOT_ID,
  readPageFormValues,
  REFRESH_ACTION_KEY,
} from './market/page.js'
import type { MarketSlotLocale, MarketPageEntry, MarketPageSourceResult } from './market/page.js'
import { createHostAssetTransport, pickHostAssets } from './market/transport.js'
import { manifest } from './manifest.js'
import { describeTrustVerdict, verifySourceTrust } from './trust/source-verdict.js'
import type { AssetTrustVerdict } from './trust/source-verdict.js'
import type {
  PluginContext,
  PluginSlotActionPayload,
  PluginSlotActionResponse,
  PluginSlotDataHandler,
  PluginSlotDescriptor,
  PluginSettingValue,
} from './types.js'

export { manifest }
export * from './humanize/index.js'
export * from './host/snapshot.js'
export * from './trust/root-ca.js'
export * from './trust/source-verdict.js'
export * from './trust/x509.js'

// 首次激活提示使用的宿主文案键,取自宿主 i18n 的既有键,插件不自造文案
const INSTALL_NOTICE_KEY = 'pluginInstallDone'

// events.on 与 chat.onBeforeRequest 返回的释放函数由引擎在停用与卸载时自动执行,
// 这里只保留引用用于观察
let releaseSessionSubscription: (() => void) | null = null
let releaseRequestHandler: (() => void) | null = null
let active = false
let firstActivation = true

/**
 * 当前使用快照中按类型的内容。
 * 由激活时的快照读取或 importAssetPackage 交付给 setActiveContents;未交付时为空,请求保持原样。
 */
let activeContents: AssetContents = {}

/**
 * 激活时拿到的插件存储引用。
 * 快照的常规读写已改走 IndexedDB,这里只用于一次性迁移时读取并删除过渡快照的旧键。
 */
let storage: PluginContext['storage'] | null = null

/** 激活时打开的快照仓库;IndexedDB 不可用或未激活时为 null */
let snapshotStore: SnapshotStore | null = null

/** 测试注入点:替换快照仓库的 IndexedDB 工厂;生产代码不调用,缺省用 globalThis.indexedDB */
let snapshotDbFactory: IDBFactory | null | undefined

/** 激活时拿到的日志出口;未激活时不写日志 */
let logger: ((message: string) => void) | null = null

/**
 * 市场远端取件通道:激活时把 context.assets.readText 包装成内核的 transport 注入。
 * 宿主没有 assets 成员或清单未获 assets:read 时为 null,URL 资产保持 transport-missing
 * 的现状,本地资产不受影响。
 */
let marketTransport: AssetTextTransport | null = null

/**
 * 市场设置值的只读出口:激活时对准宿主的 settings.values(),停用时断开。
 * 来源开关与自建来源字段的生效值在每次目录取件时重新读取,不做缓存。
 */
let marketSettingsValues: () => Record<string, PluginSettingValue> | null = () => null

/* ---------- 资产市场 slot(ui:slot):登记、动作分发与目录短缓存 ---------- */

/**
 * 目录的内存短缓存:键是合集 id,值是取件结果与取件时刻。
 * 时长见 page.ts 的 CATALOG_CACHE_TTL_MS(5 分钟,对齐设计 8.1 的内存缓存建议):
 * 数据处理器每次索取模型先用缓存出模型,缓存过期或缺失才发起取件,
 * 平衡 assets:read 的 20 次 / 10 秒与 settings:surface 的 60 次 / 10 秒预算;
 * 「刷新目录」动作绕过缓存重新取件。
 */
const pageCatalogCache = new Map<string, { result: CatalogResult; at: number }>()

/** 测试注入点:替换缓存时效判断用的时钟,undefined 恢复默认 */
let pageClock: () => number = () => Date.now()

/** slot 目录的取件任务;单飞,进行中时数据处理器对缺失来源显示「读取中」占位 */
let pagePullInFlight: Promise<void> | null = null

/** 数据处理器最近一次模型构建的条目登记表;动作回调按条目键查表还原安装参数 */
let pageItemEntries: readonly MarketPageEntry[] = []

/**
 * 表单草稿的会话内覆盖值。引擎约定 slot 表单的值不落盘(只活在宿主侧脏值生命周期),
 * 所以动作载荷带表单时把草稿值记在这里,本会话内的取件与安装都按它解析来源;
 * 持久保存仍走插件设置页(settings:surface 的写侧归宿主),停用时清空。
 */
let pageFormOverride: Record<string, PluginSettingValue> | null = null

/**
 * slot 条目触发的安装入口;null 时用 installMarketPackage。
 * 测试注入点:替换后观察动作分发到安装层的参数,undefined 恢复默认。
 */
export type MarketInstaller = (
  sourceId: string,
  author: string,
  packageId: string,
  version?: string,
) => Promise<MarketInstallResult>
let pageInstaller: MarketInstaller | null = null

/** 测试注入点:替换 slot 目录缓存时效判断用的时钟 */
export const setMarketPageClock = (clock?: () => number): void => {
  pageClock = clock ?? (() => Date.now())
}

/** 测试注入点:替换 slot 动作分发的安装入口 */
export const setMarketInstaller = (installer?: MarketInstaller): void => {
  pageInstaller = installer ?? null
}

/**
 * 安装气泡用的宿主文案键。宿主主线已为资产包新增成对键:
 * pluginAssetInstalled(资产包 {id} 安装完成)与
 * pluginAssetInstallFailed(资产包 {id} 安装失败:{reason})。
 * 旧键 pluginInstalled / pluginInstallRejected 是插件安装的文案,文案里说的是「插件」,
 * 用在资产包上会把资产说成插件,所以这里直切资产专用键。
 *
 * 兼容策略:notify(key, params) 只写不读,宿主也没有提供「字典里有没有这个键」的查询能力,
 * 插件在运行时探测不到键是否存在,因此不在这里做「缺键回落旧键」的分支——能探测才回落,
 * 探测不到就直切。宿主未提供这对键时气泡取不到文案(不显示文字),安装本身照常完成;
 * 兼容下限写在 README「资产市场」一节:宿主需为资产包提供这两个键。
 */
const INSTALL_SUCCESS_KEY = 'pluginAssetInstalled'
const INSTALL_FAILED_KEY = 'pluginAssetInstallFailed'

/** 激活时拿到的 notify 出口;未激活时 slot 动作不提示 */
let notifier: ((key: string, params?: Record<string, string | number>) => void) | null = null

/**
 * 标题的宿主语言;激活时定一次,登记描述与数据模型共用,两侧标题不漂移。
 * locale 取不到或抛错时按中文处理,与设置字段标签的取词口径一致。
 */
let slotLocale: MarketSlotLocale = 'zh-CN'

const resolveSlotLocale = async (context: PluginContext): Promise<MarketSlotLocale> => {
  try {
    return (await context.settings.locale()) === 'en-US' ? 'en-US' : 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

/** 市场安装记录与来源配置的存储键;单插件存储上限 64KB,记录裁到最近 50 条 */
const MARKET_STORAGE_KEY = 'dsc-humanize/market/v1'
const MARKET_RECORD_LIMIT = 50

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const log = (message: string): void => {
  logger?.(manifest.id + ': ' + message)
}

/** 测试注入点:替换快照仓库的 IndexedDB 工厂,undefined 恢复默认 */
export const setSnapshotDbFactory = (factory?: IDBFactory | null): void => {
  snapshotDbFactory = factory
}

/**
 * 装配入口:按类型交付当前使用的内容,形状与内核的装配参数一致。
 * 只影响之后的请求,已经发出的请求不受影响。
 */
export const setActiveContents = (contents: AssetContents): void => {
  activeContents = contents
}

/**
 * 从 IndexedDB 读取当前使用快照并装配。
 *
 * 装配只读快照:激活时先把内容清空,快照合法才交付;没有快照或快照不合法都保持空内容,
 * 请求按原样发出,不阻断激活,也不做部分保留。IndexedDB 里没有记录时,读一次插件存储里
 * 的过渡快照并做一次性迁移:读到旧键就搬进 IndexedDB 并删除旧键;迁移失败不阻断激活,
 * 旧键保留,下次激活重试。激活之后由 setActiveContents 与导入入口替换内容,
 * 下一次激活重新以快照为准。
 */
const loadSnapshot = async (): Promise<void> => {
  setActiveContents({})

  const target = storage
  const store = await openSnapshotStore(snapshotDbFactory)
  snapshotStore = store

  // 先读 IndexedDB;读不到记录时回退读一次插件存储里的过渡快照
  let raw: unknown
  let found = false
  let fromLegacy = false
  if (store !== null) {
    try {
      const value = await store.read()
      if (value !== undefined) {
        raw = value
        found = true
      }
    } catch (error) {
      log('读取 IndexedDB 快照失败,尝试过渡快照: ' + describeError(error))
    }
  }
  if (!found && target !== null) {
    try {
      const value = target.get(SNAPSHOT_STORAGE_KEY)
      if (value !== null && value !== undefined) {
        raw = value
        found = true
        fromLegacy = true
      }
    } catch (error) {
      log('读取插件存储里的过渡快照失败: ' + describeError(error))
    }
  }

  if (!found) {
    log('未找到当前使用快照,保持空内容')
    return
  }

  const result = readActiveSnapshot(raw)
  if (!result.ok) {
    log('当前使用快照不可用(' + result.error.code + '),保持空内容: ' + result.error.message)
    return
  }

  setActiveContents(result.snapshot.contents)
  log('已从当前使用快照装配 ' + Object.keys(result.snapshot.contents).length + ' 类内容')

  // 一次性迁移:过渡快照搬进 IndexedDB 后删除旧键;写不进去就保留旧键,下次激活重试
  if (fromLegacy && store !== null && target !== null) {
    try {
      await store.write(createSnapshot(result.snapshot.contents))
      target.remove(SNAPSHOT_STORAGE_KEY)
      log('已把插件存储里的过渡快照迁入 IndexedDB,并删除旧键')
    } catch (error) {
      log('迁移过渡快照到 IndexedDB 失败,旧键保留,不阻断激活: ' + describeError(error))
    }
  }
}

/** 资产包导入结果:成功给出包、是否已写入快照与两轴信任结论,失败给出内核的读取错误 */
export type AssetImportResult =
  | { ok: true; asset: AssetPackage; persisted: boolean; trust: AssetTrustVerdict }
  | { ok: false; error: AssetLoadError }

/** 导入一份资产包文档时的可选参数 */
export type AssetImportOptions = {
  /** 包的来源证书 PEM;给出时先做链校验,链不过只降级来源结论、不阻断导入 */
  sourceCertPem?: string
  /** 校验时刻;缺省取当前时间,测试用它构造过期与未生效的反例 */
  now?: Date
}

/**
 * 显式导入一份资产包文档(JSON 文本),供将来的界面调用。
 *
 * 与 setActiveContents 的分工:这一条走完整的读取与校验,成功才替换当前使用的内容,
 * 并在已激活且 IndexedDB 可用时把同一份内容写进当前使用快照;超过体积上限或写入失败
 * 不回滚内存里的装配结果,只把 persisted 置为 false 并写日志,因为请求已经能按新内容改写。
 * 未激活时只装配到内存,下次激活会重新读快照。
 *
 * 带来源证书时先按 3.8 做链校验并给出两轴结论(签名结论 + 来源结论):
 * 链不过或证书主题与包标识不一致时来源结论降级为未通过,导入照常完成,不阻断。
 */
export const importAssetPackage = async (
  jsonText: string,
  options: AssetImportOptions = {},
): Promise<AssetImportResult> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText) as unknown
  } catch {
    return { ok: false, error: { code: 'invalid-json', message: '资产包文档不是合法 JSON' } }
  }

  const result = readAssetPackage(parsed)
  if (!result.ok) return { ok: false, error: result.error }

  const asset = result.asset

  const trust = await verifySourceTrust(asset.source.id, options)
  log('导入资产包 ' + asset.source.id + ',来源结论: ' + describeTrustVerdict(trust))

  setActiveContents(asset.contents)

  if (!active || snapshotStore === null) {
    log('导入资产包 ' + asset.source.id + ',当前未激活或 IndexedDB 不可用,只装配到内存')
    return { ok: true, asset, persisted: false, trust }
  }

  try {
    await snapshotStore.write(createSnapshot(asset.contents))
    log('导入资产包 ' + asset.source.id + ',已写入当前使用快照')
    return { ok: true, asset, persisted: true, trust }
  } catch (error) {
    log('导入资产包 ' + asset.source.id + ',已装配但写入快照失败: ' + describeError(error))
    return { ok: true, asset, persisted: false, trust }
  }
}

/* ---------- 资产市场:目录取件与安装入口(设计 asset-market.md) ---------- */

/** 当前生效的远端取件通道;未激活或宿主没有 assets 成员时为 null */
export const getMarketTransport = (): AssetTextTransport | null => marketTransport

/** 一次目录取件的对外结果,错误码 transport-missing / source-unreachable / source-unknown / source-disabled */
export type MarketCatalogResult = CatalogResult

/**
 * 拉一个来源的包目录(设计 3.1 第 1-3 步与第 7 步)。
 *
 * sourceId 缺省时取优先级最高且已启用的内置来源;来源开关与自建来源字段
 * 每次调用都从宿主设置值重新解析。宿主没有 assets:read 通道时返回 transport-missing,
 * 不发任何请求;通道存在时单次取件的限流与三态口径由宿主落实。
 */
export const fetchMarketCatalog = async (sourceId?: string): Promise<MarketCatalogResult> => {
  const { sources } = resolveMarketSources(pageFormOverride ?? marketSettingsValues())
  const source =
    sourceId === undefined
      ? sources.find((item) => item.enabled) ?? null
      : sources.find((item) => item.id === sourceId) ?? null
  if (source === null) {
    return {
      ok: false,
      error: {
        code: sourceId === undefined ? 'source-unreachable' : 'source-unknown',
        message: sourceId === undefined ? '没有已启用的来源' : '找不到这个来源: ' + sourceId,
      },
    }
  }
  return fetchCatalog({ source, transport: marketTransport })
}

/** 一条安装记录(设计 4.4):回答从哪来、是什么、信不信、什么时候装 */
export interface MarketInstallRecord {
  /** 来源:合集 id 与本次实际生效的 base_url */
  readonly collectionId: string
  readonly baseUrl: string
  /** 包:作者、包标识、版本、格式版本;与快照来源记录对齐 */
  readonly author: string
  readonly packageId: string
  readonly version: string
  readonly formatVersion: string
  /** 类型集合:包声明的四类(或五类)中的哪几类 */
  readonly types: readonly string[]
  /** 两轴结论,每次安装重新计算,不采信旧值 */
  readonly trust: CatalogTrust
  /** 包层清单修订号,供回退提示 */
  readonly revision?: number
  /** 安装时间(ISO 文本) */
  readonly installedAt: string
}

/** 安装记录的存储形状;结构不符时整体重置,不做部分保留 */
interface MarketStorageValue {
  installs: readonly MarketInstallRecord[]
}

/** 读取安装记录;键缺失或结构不符时返回空清单 */
const readInstallRecords = (): MarketInstallRecord[] => {
  const target = storage
  if (target === null) return []
  try {
    const value = target.get(MARKET_STORAGE_KEY)
    if (typeof value !== 'object' || value === null) return []
    const installs = (value as { installs?: unknown }).installs
    if (!Array.isArray(installs)) return []
    return installs as MarketInstallRecord[]
  } catch {
    return []
  }
}

/** 追加一条安装记录;写失败只记日志,不影响装配结果 */
const appendInstallRecord = (record: MarketInstallRecord): boolean => {
  const target = storage
  if (target === null) return false
  const installs = [...readInstallRecords(), record].slice(-MARKET_RECORD_LIMIT)
  try {
    target.set(MARKET_STORAGE_KEY, { installs } satisfies MarketStorageValue)
    return true
  } catch (error) {
    log('安装记录写入失败(安装结果不受影响): ' + describeError(error))
    return false
  }
}

/** 一次市场安装的结果;失败时取件与校验都没落盘,已有内容保持不变 */
export type MarketInstallResult =
  | {
      ok: true
      asset: AssetPackage
      /** 装配是否写进了当前使用快照,语义与 importAssetPackage 一致 */
      persisted: boolean
      /** 两轴结论:签名结论 + 来源结论,来自本次安装时的链校验 */
      trust: CatalogTrust
      record: MarketInstallRecord
      /** 安装记录是否写进了插件存储 */
      recordPersisted: boolean
    }
  | { ok: false; error: MarketError | InstallFetchError | AssetLoadError }

/**
 * 从市场安装一个资产包(设计 4.1-4.4)。
 *
 * 流程:解析来源 → 目录取件确定本次实际生效的 base_url 与两轴结论(同址约束:
 * 安装取件沿用同一个地址)→ 按包层清单逐文件取包内文件并比对哈希 → 扁平化成
 * 加载期包文档交给 importAssetPackage 做整包校验与原子装配 → 写安装记录。
 * 任何取件或校验失败都整包拒绝,不落盘;装配成功但记录写失败时只记日志,
 * 因为请求已经能按新内容改写(与 importAssetPackage 对快照写失败的口径一致)。
 *
 * 两轴结论的来源:目录取件时用合集 EEC 证书对合集 id 做链校验(verifySourceTrust,
 * 证书主题 CN 与合集 id 一致);importAssetPackage 内部不带证书,它的导入结论按
 * 本地口径计,安装记录采用链校验的结论,两者不混用。
 */
export const installMarketPackage = async (
  sourceId: string,
  author: string,
  packageId: string,
  version?: string,
): Promise<MarketInstallResult> => {
  const catalog = await fetchMarketCatalog(sourceId)
  if (!catalog.ok) return { ok: false, error: catalog.error }

  const fetched = await fetchPackageDocument({
    baseUrl: catalog.baseUrl,
    author,
    packageId,
    transport: marketTransport,
    ...(version === undefined ? {} : { version }),
  })
  if (!fetched.ok) return { ok: false, error: fetched.error }

  const importResult = await importAssetPackage(JSON.stringify(fetched.document))
  if (!importResult.ok) return { ok: false, error: importResult.error }

  const record: MarketInstallRecord = {
    collectionId: catalog.sourceId,
    baseUrl: catalog.baseUrl,
    author,
    packageId,
    version: importResult.asset.source.version ?? '',
    formatVersion: importResult.asset.formatVersion,
    types: importResult.asset.types,
    trust: catalog.trust,
    installedAt: new Date().toISOString(),
    ...(fetched.revision === undefined ? {} : { revision: fetched.revision }),
  }
  const recordPersisted = appendInstallRecord(record)
  log(
    '市场安装 ' + packageId + '@' + record.version + ' 完成,来源 ' + catalog.sourceId +
      ',来源结论 ' + (catalog.trust.source === 'rejected' && catalog.trust.sourceReason !== undefined
        ? catalog.trust.source + '(' + catalog.trust.sourceReason + ')'
        : catalog.trust.source) +
      ',安装记录' + (recordPersisted ? '已写入' : '未写入'),
  )

  return {
    ok: true,
    asset: importResult.asset,
    persisted: importResult.persisted,
    trust: catalog.trust,
    record,
    recordPersisted,
  }
}

/** 动作失败的短原因:宿主提示参数里只带一段可读文本 */
const shortReason = (error: unknown): string => {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error)
  return text.length > 120 ? text.slice(0, 120) + '…' : text
}

/** 缓存是否仍在时效内 */
const isCacheFresh = (sourceId: string): boolean => {
  const cached = pageCatalogCache.get(sourceId)
  return cached !== undefined && pageClock() - cached.at < CATALOG_CACHE_TTL_MS
}

/**
 * 按既有 catalog 层刷新 slot 目录(设计 3.1 目录部分)。
 * 单飞:进行中时直接复用同一个任务;force 为 true 时绕过缓存逐来源重新取件。
 * 每个来源的取件结果连同取件时刻写进短缓存;单个来源失败也记录失败结果,
 * 让模型层折叠成「来源不可用」一行,不阻断其他来源。
 */
const refreshPageCatalog = (force = false): Promise<void> => {
  if (pagePullInFlight !== null) return pagePullInFlight
  const run = async (): Promise<void> => {
    try {
      const { sources } = resolveMarketSources(pageFormOverride ?? marketSettingsValues())
      for (const source of sources) {
        if (!source.enabled) {
          pageCatalogCache.delete(source.id)
          continue
        }
        if (!force && isCacheFresh(source.id)) continue
        const result = await fetchCatalog({ source, transport: marketTransport })
        pageCatalogCache.set(source.id, { result, at: pageClock() })
      }
    } catch (error) {
      log('目录刷新失败,保持已有缓存: ' + describeError(error))
    } finally {
      pagePullInFlight = null
    }
  }
  pagePullInFlight = run()
  return pagePullInFlight
}

/**
 * 数据挂载点的模型构建:每次调用都用当前缓存出模型(设计 8.1 的内存缓存口径),
 * 缓存缺失的来源给「读取中」占位,缓存过期的来源在后台补取件、本次先显示旧结果;
 * 需要补取件时发起单飞任务,取件完成后等宿主下一次索取模型或刷新指示。
 */
const buildPageModelNow = (): PluginSlotDescriptor => {
  const { sources } = resolveMarketSources(pageFormOverride ?? marketSettingsValues())
  const results: MarketPageSourceResult[] = []
  let needsPull = false
  for (const source of sources) {
    if (!source.enabled) continue
    const cached = pageCatalogCache.get(source.id)
    if (cached === undefined) {
      results.push({ source, pending: true })
      needsPull = true
      continue
    }
    results.push(
      cached.result.ok
        ? { source, catalog: cached.result }
        : { source, error: cached.result.error },
    )
    if (!isCacheFresh(source.id)) needsPull = true
  }
  if (needsPull && pagePullInFlight === null) {
    void refreshPageCatalog()
  }
  const model = buildMarketPageModel(results, slotLocale)
  pageItemEntries = model.entries
  if (model.truncated) {
    log('目录超过宿主描述的体积上限,已从尾部收敛条目: ' + MARKET_SLOT_ID)
  }
  return model.descriptor
}

/**
 * ui:slot-data 挂载点:只回答资产市场这一条目,其他条目回落到登记时的缺省模型。
 * 数据处理器同步返回描述;宿主按 (slot, id) 定位条目,描述渲染的挂载点
 * 恒为登记时的 slot,不存在跨挂载点漂移。
 */
const pageDataHandler: PluginSlotDataHandler = (slot, id) => {
  if (slot !== MARKET_SLOT || id !== MARKET_SLOT_ID) return null
  return buildPageModelNow()
}

/** 一次安装动作:分发到安装层,完成用 notify 提示成功或失败,不弹任何窗 */
const dispatchMarketInstall = async (entry: MarketPageEntry): Promise<void> => {
  const installer = pageInstaller ?? installMarketPackage
  try {
    const result = await installer(entry.sourceId, entry.author, entry.packageId)
    if (result.ok) {
      notifier?.(INSTALL_SUCCESS_KEY, { id: entry.packageId })
      log('安装 ' + entry.packageId + ' 完成,来源 ' + entry.sourceId)
    } else {
      notifier?.(INSTALL_FAILED_KEY, {
        id: entry.packageId,
        reason: shortReason(result.error.code + ': ' + result.error.message),
      })
      log('安装 ' + entry.packageId + ' 失败(' + result.error.code + '): ' + result.error.message)
    }
  } catch (error) {
    notifier?.(INSTALL_FAILED_KEY, { id: entry.packageId, reason: shortReason(error) })
    log('安装 ' + entry.packageId + ' 抛错: ' + describeError(error))
  }
}

/**
 * ui:slot-action 挂载点:刷新目录返回刷新指示;安装动作按条目键查表分发,
 * 查不到(模型已重建、条目过期)只记日志;载荷带表单草稿时先在本会话内生效。
 */
const pageActionHandler = (payload: PluginSlotActionPayload): PluginSlotActionResponse | undefined => {
  if (payload.slot !== MARKET_SLOT || payload.id !== MARKET_SLOT_ID) return undefined
  const formValues = readPageFormValues(payload.form)
  if (formValues !== null) {
    pageFormOverride = formValues
    log('表单草稿已生效(本会话内覆盖设置值参与来源解析,不落盘)')
  }
  if (payload.actionId === REFRESH_ACTION_KEY) {
    void refreshPageCatalog(true)
    return { refresh: true }
  }
  if (payload.actionId === INSTALL_ACTION_KEY && typeof payload.itemKey === 'string') {
    const entry = pageItemEntries.find((item) => item.key === payload.itemKey)
    if (entry === undefined) {
      log('安装动作的条目键已过期或不可用,已忽略: ' + payload.itemKey)
      return undefined
    }
    void dispatchMarketInstall(entry)
    return undefined
  }
  return undefined
}

/**
 * 启动入口,引擎在激活时调用,超时 5 秒。
 * 返回值被忽略,不要用它传递释放函数;快照读取在超时与降级约束内完成,失败不阻断激活。
 */
export const activate = async (context: PluginContext): Promise<void> => {
  if (active) {
    context.log(manifest.id + ': already active, skip activate')
    return
  }

  active = true
  logger = (message) => context.log(message)
  storage = context.storage

  // 市场通道接线:清单申请了 assets:read 且宿主具备 assets 成员时,把 readText 包装成
  // 内核 transport 注入;否则保持 null,URL 资产以 transport-missing 失败,本地资产不受影响
  const assetsApi = pickHostAssets(context)
  marketTransport = assetsApi === null ? null : createHostAssetTransport(assetsApi)
  log(
    marketTransport === null
      ? '宿主未提供 assets:read 读取通道,远端资产取件不可用,本地资产不受影响'
      : '已接入宿主 assets:read 读取通道,URL 资产装载与市场取件可用',
  )

  // 设置表面:登记来源开关与自建来源字段,宿主渲染表单;登记失败只记日志,不阻断激活
  marketSettingsValues = () => {
    try {
      return context.settings.values()
    } catch {
      return null
    }
  }
  try {
    if (typeof context.settings.register === 'function') {
      context.settings.register(marketSettingDescriptor)
      log('已登记资产市场设置字段(来源开关与自建来源)')
    } else {
      log('宿主没有设置表面能力,来源开关与自建来源字段不可用')
    }
  } catch (error) {
    log('登记资产市场设置字段失败,来源开关按缺省处理: ' + describeError(error))
  }

  // 资产市场 slot:登记会话视图标签栏条目与动作、数据两个挂载点;宿主没有 ui:slot 能力时跳过,不阻断激活
  notifier = (key, params) => context.ui.notify(key, params)
  try {
    if (typeof context.ui.registerSlot === 'function') {
      // 登记时的缺省模型:目录尚无缓存,列表为空;宿主索取模型时由数据挂载点补全。
      // 标题按宿主语言取成对词条的一侧,order 按标签栏的排期约定取 50。
      slotLocale = await resolveSlotLocale(context)
      context.ui.registerSlot(MARKET_SLOT, buildMarketPageModel([], slotLocale).descriptor)
      log('已登记资产市场 slot(' + MARKET_SLOT + '): ' + MARKET_SLOT_ID)
    } else {
      log('宿主没有 ui:slot 能力,资产市场标签不可用')
    }
  } catch (error) {
    log('登记资产市场 slot 失败,标签不可用但不阻断激活: ' + describeError(error))
  }
  try {
    if (typeof context.ui.onSlotAction === 'function') {
      context.ui.onSlotAction(pageActionHandler)
    }
    if (typeof context.ui.onSlotData === 'function') {
      context.ui.onSlotData(pageDataHandler)
    }
  } catch (error) {
    log('登记 slot 动作或数据挂载点失败,条目静态显示: ' + describeError(error))
  }

  context.log(
    manifest.id + ': activated, kernel ' + KERNEL_VERSION + ', capabilities ' + manifest.capabilities.join(', '),
  )

  // 先读快照再登记处理器:处理器每次请求重新读取 activeContents,顺序不影响结果,
  // 但先装配能让激活日志与首次请求看到同一份内容
  try {
    await loadSnapshot()
  } catch (error) {
    log('读取当前使用快照失败,保持空内容: ' + describeError(error))
  }

  releaseSessionSubscription = context.events.on('session:changed', (event) => {
    context.log(manifest.id + ': session:changed -> ' + String(event.activeId ?? 'none'))
  })

  releaseRequestHandler = context.chat.onBeforeRequest(
    createBeforeRequestHandler({
      contents: () => activeContents,
      log: (message) => context.log(manifest.id + ': ' + message),
    }),
  )

  if (firstActivation) {
    firstActivation = false
    context.ui.notify(INSTALL_NOTICE_KEY)
  }
}

/**
 * 停用入口,引擎在停用与卸载时调用,超时 3 秒。
 *
 * 注意：事件订阅与请求前处理器的释放函数由引擎自动执行,此处不再重复调用,
 * 只丢弃本地引用并复位插件自身的状态。当前使用的内容在停用期间保留,下一次激活以快照为准。
 */
export const deactivate = (): void => {
  // 释放函数由引擎自动执行,这里不重复调用,只丢弃本地引用
  if (releaseSessionSubscription !== null) {
    releaseSessionSubscription = null
  }
  if (releaseRequestHandler !== null) {
    releaseRequestHandler = null
  }
  snapshotStore?.close()
  snapshotStore = null
  storage = null
  logger = null
  notifier = null
  marketTransport = null
  marketSettingsValues = () => null
  pageCatalogCache.clear()
  pagePullInFlight = null
  pageItemEntries = []
  pageFormOverride = null
  pageInstaller = null
  pageClock = () => Date.now()
  slotLocale = 'zh-CN'
  active = false
}
