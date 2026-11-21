import { createBeforeRequestHandler } from './host/request-patch.js'
import { openSnapshotStore } from './host/snapshot-db.js'
import type { SnapshotStore } from './host/snapshot-db.js'
import { SNAPSHOT_STORAGE_KEY, createSnapshot, readActiveSnapshot } from './host/snapshot.js'
import { readAssetPackage } from './humanize/assets/loader.js'
import { KERNEL_VERSION } from './humanize/index.js'
import type { AssetContents, AssetLoadError, AssetPackage } from './humanize/types.js'
import { manifest } from './manifest.js'
import { describeTrustVerdict, verifySourceTrust } from './trust/source-verdict.js'
import type { AssetTrustVerdict } from './trust/source-verdict.js'
import type { PluginContext } from './types.js'

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
  active = false
}
