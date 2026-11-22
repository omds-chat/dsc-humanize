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
import { buildAssetNotice } from './slots/asset-notice.js'
import type { AssetSourceReachability } from './slots/asset-notice.js'
import {
  buildRewriteButtonDescriptor,
  createRewriteSwitchRecord,
  readRewriteSwitch,
  REWRITE_ACTION_KEY,
  REWRITE_BUTTON_ID,
  REWRITE_SWITCH_DEFAULT,
  REWRITE_SWITCH_SLOT,
  REWRITE_SWITCH_STORAGE_KEY,
  REWRITE_TOGGLE_NOTICE_KEY,
  rewriteToggleNoticeParams,
} from './slots/rewrite-switch.js'
import {
  buildSettingsPageDescriptor,
  createAssetSourcesRecord,
  mergeSourceValues,
  readAssetSourcesRecord,
  readSourcesFormValues,
  SAVE_SOURCES_ACTION_KEY,
  SETTINGS_PAGE_ID,
  SETTINGS_PAGE_SLOT,
  SETTINGS_PAGE_STORAGE_KEY,
} from './slots/settings-page.js'
import { describeTrustVerdict, verifySourceTrust } from './trust/source-verdict.js'
import type { AssetTrustVerdict } from './trust/source-verdict.js'
import type {
  PluginContext,
  PluginSlotActionPayload,
  PluginSlotActionResponse,
  PluginSlotDataHandler,
  PluginSlotDescriptorBody,
  PluginSlotHandle,
  PluginSlotName,
  PluginSlotPageModel,
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

/**
 * 设置页(settings.page)保存的来源配置,激活时从插件存储读取,保存动作写回。
 * null 表示没有保存记录(键缺失、形状不符或版本不符),来源解析回落到宿主设置值。
 * 存储键见 settings-page.ts 的 SETTINGS_PAGE_STORAGE_KEY。
 */
let savedSourceValues: Record<string, PluginSettingValue> | null = null

/**
 * 当前生效的来源配置值:设置页保存值优先,其次宿主 settings:surface 的生效值。
 *
 * 取件、安装、通知与设置页表单回填全部经这一个出口,两个表面读到的是同一份配置;
 * 插件侧的设置面只读,宿主也不告诉插件「这个字段是否被用户覆盖过」,
 * 因此优先级只能按可写侧在前来定,取舍理由写在 settings-page.ts 的文件头。
 */
const currentSettingValues = (): Record<string, PluginSettingValue> | null =>
  mergeSourceValues(savedSourceValues, marketSettingsValues())

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

/* ---------- 槽位:人性化按钮(composer.toolbar)与资产状态通知(overlay.notice) ---------- */

/** 激活时拿到的 ui 出口;未激活时为 null,槽位登记与撤销都经它转出 */
let hostUi: PluginContext['ui'] | null = null

/**
 * 「是否启用资产改写」的当前值。
 * 激活时从插件存储读取(键独立于快照与市场记录),切换时写回;
 * 关闭时请求前处理器直接返回 null,请求保持原样。
 */
let rewriteEnabled = REWRITE_SWITCH_DEFAULT

/** composer.toolbar 的登记句柄;每次切换后重新登记(同 id 替换),这里只留最新一份 */
let rewriteButtonHandle: PluginSlotHandle | null = null

/** overlay.notice 的登记句柄;为 null 表示当前没有登记、界面上没有通知卡片 */
let assetNoticeHandle: PluginSlotHandle | null = null

/** 当前已登记通知的正文;正文不变就不重新登记,免得每次取件都扰动界面 */
let assetNoticeSignature: string | null = null

/**
 * 从插件存储读取「资产改写」开关。
 * 读不到(未激活、键缺失)或读失败都落到缺省值(开启),不阻断激活;
 * 记录形状由 readRewriteSwitch 收敛,版本不符按缺省处理。
 */
const loadRewriteSwitch = (): void => {
  rewriteEnabled = REWRITE_SWITCH_DEFAULT
  const target = storage
  if (target === null) return
  try {
    rewriteEnabled = readRewriteSwitch(target.get(REWRITE_SWITCH_STORAGE_KEY))
  } catch (error) {
    log('读取资产改写开关失败,按缺省(开启)处理: ' + describeError(error))
  }
}

/**
 * 把开关写回插件存储;写失败只记日志,本次会话内仍然生效。
 * 返回是否写入成功,供日志区分两种情形。
 */
const persistRewriteSwitch = (enabled: boolean): boolean => {
  const target = storage
  if (target === null) return false
  try {
    target.set(REWRITE_SWITCH_STORAGE_KEY, createRewriteSwitchRecord(enabled))
    return true
  } catch (error) {
    log('资产改写开关写入失败(本次会话内仍生效): ' + describeError(error))
    return false
  }
}

/**
 * 从插件存储读取设置页保存的来源配置。
 * 读不到(未激活、键缺失、形状或版本不符)或读失败都按「没有保存值」处理,
 * 来源解析回落到宿主设置值,不阻断激活。
 */
const loadSavedSourceValues = (): void => {
  savedSourceValues = null
  const target = storage
  if (target === null) return
  try {
    savedSourceValues = readAssetSourcesRecord(target.get(SETTINGS_PAGE_STORAGE_KEY))
  } catch (error) {
    log('读取设置页保存的来源配置失败,按宿主设置值处理: ' + describeError(error))
  }
}

/**
 * 把设置页的保存值写回插件存储;写失败只记日志,本次会话内仍然生效
 * (与人性化开关同一口径)。返回是否写入成功,供日志区分两种情形。
 */
const persistSourceValues = (values: Record<string, PluginSettingValue>): boolean => {
  const target = storage
  if (target === null) return false
  try {
    target.set(SETTINGS_PAGE_STORAGE_KEY, createAssetSourcesRecord(values))
    return true
  } catch (error) {
    log('设置页的来源配置写入失败(本次会话内仍生效): ' + describeError(error))
    return false
  }
}

/**
 * settings.page 的动作:保存来源配置。
 *
 * 表单草稿不落盘是引擎口径(宿主只在动作回调里带上草稿),所以「保存」只能是插件自己的动作:
 * 把草稿收敛成设置字段的值,与已有保存值合并后写入插件存储,下一次取件即按新来源解析。
 *
 * 两件配套的事:
 * - 清掉资产市场标签里同字段的旧草稿:两个表面是同一份字段,设置页的保存是更晚的一次完整提交,
 *   旧草稿不再代表用户意图,留着会让刚保存的值在取件时被草稿盖住;
 * - 清空目录短缓存:来源范围可能变了(新增自建来源、关掉内置来源),下一次取件按新来源重新取件。
 *
 * 返回刷新指示,宿主重新索取本页模型,表单字段的默认值随新的生效值回填。
 */
const saveSourcesFromSettingsPage = (
  form: Record<string, unknown> | undefined,
): PluginSlotActionResponse => {
  const values = readSourcesFormValues(form)
  if (values === null) {
    log('设置页的保存动作没有带可用的表单值,未写入')
    return { refresh: true }
  }
  savedSourceValues = { ...(savedSourceValues ?? {}), ...values }
  const persisted = persistSourceValues(savedSourceValues)
  if (pageFormOverride !== null) {
    pageFormOverride = null
    log('设置页已保存,资产市场标签里的来源草稿一并失效')
  }
  pageCatalogCache.clear()
  syncAssetNotice()
  log(
    '已保存来源配置' +
      (persisted ? ',已写入插件设置' : ',写入插件设置失败,本次会话内仍生效') +
      ',下一次取件生效: ' + Object.keys(values).join(', '),
  )
  return { refresh: true }
}

/** 登记一次槽位描述;宿主没有 ui:slot 或登记被拒时只记日志,不阻断激活 */
const registerSlotSafely = (
  slot: PluginSlotName,
  descriptor: PluginSlotDescriptorBody,
  failure: string,
): PluginSlotHandle | null => {
  const ui = hostUi
  if (ui === null || typeof ui.registerSlot !== 'function') return null
  try {
    return ui.registerSlot(slot, descriptor)
  } catch (error) {
    log(failure + ': ' + describeError(error))
    return null
  }
}

/**
 * 登记工具条按钮(文案里带开关状态:开 / 关)。
 * 切换开关后再调一次:宿主对同插件同 id 是替换语义,界面据此刷新按钮文字;
 * 工具条没有页面模型,不需要刷新指示。
 */
const registerRewriteButton = (): void => {
  const handle = registerSlotSafely(
    REWRITE_SWITCH_SLOT,
    buildRewriteButtonDescriptor(slotLocale, rewriteEnabled),
    '登记人性化按钮失败,工具条按钮不可用',
  )
  if (handle === null) return
  // 只在首次登记时记一行;切换后的重新登记是常态,不必每次刷日志
  if (rewriteButtonHandle === null) {
    log(
      '已登记人性化按钮(' + REWRITE_SWITCH_SLOT + '): ' + REWRITE_BUTTON_ID +
        ',当前' + (rewriteEnabled ? '开启' : '关闭'),
    )
  }
  rewriteButtonHandle = handle
}

/**
 * 一次「人性化」点击:翻转开关 → 落盘 → 重新登记按钮刷新状态 → 一次气泡说明当前状态。
 * 气泡用宿主文案键(带 {state} 参数),不弹窗、不遮罩;
 * 宿主字典缺该键时按 i18n 的缺键口径显示键名,状态本身不受影响。
 */
const toggleRewriteSwitch = (): void => {
  rewriteEnabled = !rewriteEnabled
  const persisted = persistRewriteSwitch(rewriteEnabled)
  registerRewriteButton()
  // 气泡失败(宿主 notify 限流 10 次 / 10 秒、或宿主没有该能力)不影响已经生效的开关
  try {
    notifier?.(REWRITE_TOGGLE_NOTICE_KEY, rewriteToggleNoticeParams(slotLocale, rewriteEnabled))
  } catch (error) {
    log('改写状态气泡发送失败,开关已生效: ' + describeError(error))
  }
  log(
    '资产改写已' + (rewriteEnabled ? '开启' : '关闭') +
      (persisted ? ',已写入插件存储' : ',写入插件存储失败,本次会话内仍生效'),
  )
}

/**
 * 已启用来源的可达性。
 * 只有真的取了件、且全部失败才算不可达(取件通道缺失同样算):没有取件结论时返回 unknown,
 * 免得插件刚激活就把「还没开始」报成失败;任一来源取件成功即算可达,单来源失败由
 * 资产市场标签里的逐行说明承担,不升级成全局通知。
 */
const readSourceReachability = (): AssetSourceReachability => {
  const { sources } = resolveMarketSources(pageFormOverride ?? currentSettingValues())
  let enabled = 0
  let reached = 0
  let failed = 0
  let reason = ''
  for (const source of sources) {
    if (!source.enabled) continue
    enabled += 1
    const cached = pageCatalogCache.get(source.id)
    if (cached === undefined) continue
    if (cached.result.ok) {
      reached += 1
      continue
    }
    failed += 1
    if (reason === '') {
      reason = cached.result.error.code + ': ' + cached.result.error.message
    }
  }
  if (reached > 0) return { status: 'reachable' }
  if (enabled === 0) return { status: 'unreachable', reason: '没有已启用的资产来源' }
  if (marketTransport === null) return { status: 'unreachable', reason: '宿主未提供 assets:read 读取通道' }
  if (failed > 0) return { status: 'unreachable', reason }
  return { status: 'unknown' }
}

/**
 * 同步 overlay.notice 的常驻通知:有问题就登记并刷新正文,问题消失就撤销登记。
 *
 * 只在事实变化时动手:正文相同则不重新登记,避免每次取件都重新登记一次
 * (ui:slot 的登记次数计入 20 次 / 10 秒的限流,重复登记也让界面空转)。
 * 通知只说明原因,不改请求、不阻断安装。
 */
const syncAssetNotice = (): void => {
  // 未激活时不登记:停用后仍在收尾的取件任务不应把通知卡片重新登记回来
  if (!active) return
  const descriptor = buildAssetNotice({
    contents: activeContents,
    sources: readSourceReachability(),
    locale: slotLocale,
  })
  if (descriptor === null) {
    if (assetNoticeHandle !== null) {
      assetNoticeHandle.dispose()
      assetNoticeHandle = null
      log('资产来源与资产包都可用,已撤销资产状态通知')
    }
    assetNoticeSignature = null
    return
  }
  if ((descriptor.text ?? null) === assetNoticeSignature) return
  const handle = registerSlotSafely('overlay.notice', descriptor, '登记资产状态通知失败,通知卡片不可用')
  if (handle !== null) {
    assetNoticeHandle = handle
    assetNoticeSignature = descriptor.text ?? null
    log('已登记资产状态通知: ' + (descriptor.text ?? ''))
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
  // 装配内容变了:资产包从「空」变成「可用」时撤销常驻通知,后续仍按实际情况重新评估
  syncAssetNotice()

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
  const { sources } = resolveMarketSources(pageFormOverride ?? currentSettingValues())
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
      const { sources } = resolveMarketSources(pageFormOverride ?? currentSettingValues())
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
      // 取件结论变了:来源由不可达转为可达(或反之)时,常驻通知随之撤销或登记
      syncAssetNotice()
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
const buildPageModelNow = (): PluginSlotPageModel => {
  const { sources } = resolveMarketSources(pageFormOverride ?? currentSettingValues())
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
  // 回流模型带槽位头:宿主按 (slot, id) 校验一致性,缺 slot 的模型会被拒绝并回落到登记时的缺省模型
  return { slot: MARKET_SLOT, ...model.descriptor }
}

/**
 * ui:slot-data 挂载点:回答资产市场标签与资产来源设置页两个页面,其他条目回落到登记时的缺省模型。
 * 数据处理器同步返回描述;宿主按 (slot, id) 定位条目,描述渲染的挂载点
 * 恒为登记时的 slot,不存在跨挂载点漂移。
 *
 * 设置页每次索取模型都按当前生效值回填表单字段的默认值:打开设置页看到的就是
 * 正在生效的配置,保存后宿主重新索取时也按新值回填。
 */
const pageDataHandler: PluginSlotDataHandler = (slot, id) => {
  if (slot === SETTINGS_PAGE_SLOT) {
    if (id !== SETTINGS_PAGE_ID) return null
    return { slot: SETTINGS_PAGE_SLOT, ...buildSettingsPageDescriptor(slotLocale, currentSettingValues()) }
  }
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
    syncAssetNotice()
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
 * ui:slot-action 挂载点:按载荷的 slot 分流。
 *
 * 引擎对每个插件只保留一份动作回调,载荷一定带 slot(同一份回调服务全部已登记槽位):
 * composer.toolbar 的按钮翻转「资产改写」开关,settings.page 的保存动作写入来源配置,
 * conversation.tabs 的动作交给市场页处理。
 * 工具条没有页面模型,翻转后返回 undefined(刷新指示对位置型槽位没有意义),
 * 按钮文案靠重新登记刷新。
 */
const slotActionHandler = (payload: PluginSlotActionPayload): PluginSlotActionResponse | undefined => {
  if (payload.slot === REWRITE_SWITCH_SLOT) {
    if (payload.id !== REWRITE_BUTTON_ID || payload.actionId !== REWRITE_ACTION_KEY) return undefined
    toggleRewriteSwitch()
    return undefined
  }
  if (payload.slot === SETTINGS_PAGE_SLOT) {
    if (payload.id !== SETTINGS_PAGE_ID || payload.actionId !== SAVE_SOURCES_ACTION_KEY) return undefined
    return saveSourcesFromSettingsPage(payload.form)
  }
  return pageActionHandler(payload)
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

  // 四处 ui:slot 落点:资产市场标签(conversation.tabs)、资产来源设置页(settings.page)、
  // 人性化按钮(composer.toolbar)与资产状态通知(overlay.notice);
  // 宿主没有 ui:slot 能力时全部跳过,不阻断激活
  notifier = (key, params) => context.ui.notify(key, params)
  hostUi = context.ui
  // 标题与按钮文案共用一份语言判定,两侧不漂移
  slotLocale = await resolveSlotLocale(context)

  // 资产改写开关:从插件存储读取,键独立于快照与市场记录;缺省开启
  loadRewriteSwitch()
  // 设置页保存的来源配置:同样从插件存储读取,键独立于开关与安装记录
  loadSavedSourceValues()

  try {
    if (typeof context.ui.registerSlot === 'function') {
      // 登记时的缺省模型:目录尚无缓存,列表为空;宿主索取模型时由数据挂载点补全。
      // 标题按宿主语言取成对词条的一侧,order 按标签栏的排期约定取 50。
      context.ui.registerSlot(MARKET_SLOT, buildMarketPageModel([], slotLocale).descriptor)
      log('已登记资产市场 slot(' + MARKET_SLOT + '): ' + MARKET_SLOT_ID)
    } else {
      log('宿主没有 ui:slot 能力,资产市场标签不可用')
    }
  } catch (error) {
    log('登记资产市场 slot 失败,标签不可用但不阻断激活: ' + describeError(error))
  }

  // 资产来源设置页:设置 → 插件 → 资产来源。表单字段与 settings:surface 同源,
  // 「保存来源配置」动作写入插件设置,下一次取件生效;登记时的缺省模型按当前生效值回填。
  try {
    if (typeof context.ui.registerSlot === 'function') {
      context.ui.registerSlot(
        SETTINGS_PAGE_SLOT,
        buildSettingsPageDescriptor(slotLocale, currentSettingValues()),
      )
      log('已登记资产来源设置页(' + SETTINGS_PAGE_SLOT + '): ' + SETTINGS_PAGE_ID)
    } else {
      log('宿主没有 ui:slot 能力,资产来源设置页不可用')
    }
  } catch (error) {
    log('登记资产来源设置页失败,设置入口不可用但不阻断激活: ' + describeError(error))
  }

  // 人性化按钮:文案带开关状态,切换后按同 id 重新登记刷新
  if (typeof context.ui.registerSlot === 'function') {
    registerRewriteButton()
  }

  try {
    // 引擎对每个插件只保留一份动作回调与一份数据处理器(后登记者替换前一份),
    // 但登记入口按槽位授权;这里逐个已用槽位登记同一份回调,载荷的 slot 负责分流。
    // 位置型槽位没有页面模型,页面型槽位(conversation.tabs 与 settings.page)才需要数据处理器。
    if (typeof context.ui.onSlotAction === 'function') {
      for (const slot of [MARKET_SLOT, SETTINGS_PAGE_SLOT, REWRITE_SWITCH_SLOT] as const) {
        context.ui.onSlotAction(slot, slotActionHandler)
      }
    }
    if (typeof context.ui.onSlotData === 'function') {
      for (const slot of [MARKET_SLOT, SETTINGS_PAGE_SLOT] as const) {
        context.ui.onSlotData(slot, pageDataHandler)
      }
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

  // 装配结果确定后再评估常驻通知:空包或来源不可达才登记,正常时不登记
  syncAssetNotice()

  releaseSessionSubscription = context.events.on('session:changed', (event) => {
    context.log(manifest.id + ': session:changed -> ' + String(event.activeId ?? 'none'))
  })

  releaseRequestHandler = context.chat.onBeforeRequest(
    createBeforeRequestHandler({
      contents: () => activeContents,
      // 开关关闭时请求前处理器直接返回 null,请求保持原样
      enabled: () => rewriteEnabled,
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
  savedSourceValues = null
  pageInstaller = null
  pageClock = () => Date.now()
  slotLocale = 'zh-CN'
  // 槽位登记与挂载点的释放函数由引擎执行,这里只丢弃句柄与本地状态;
  // 开关回到缺省值,下一次激活以插件存储为准
  hostUi = null
  rewriteEnabled = REWRITE_SWITCH_DEFAULT
  rewriteButtonHandle = null
  assetNoticeHandle = null
  assetNoticeSignature = null
  active = false
}
