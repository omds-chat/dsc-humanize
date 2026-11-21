import { createBeforeRequestHandler } from './host/request-patch.js'
import { SNAPSHOT_STORAGE_KEY, createSnapshot, readActiveSnapshot } from './host/snapshot.js'
import { readAssetPackage } from './humanize/assets/loader.js'
import { KERNEL_VERSION } from './humanize/index.js'
import type { AssetContents, AssetLoadError, AssetPackage } from './humanize/types.js'
import { manifest } from './manifest.js'
import type { PluginContext, PluginStorageApi } from './types.js'

export { manifest }
export * from './humanize/index.js'
export * from './host/snapshot.js'
export * from './trust/root-ca.js'

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

/** 激活时拿到的插件存储引用;未激活时为空,导入只装配到内存 */
let storage: PluginStorageApi | null = null

/** 激活时拿到的日志出口;未激活时不写日志 */
let logger: ((message: string) => void) | null = null

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const log = (message: string): void => {
  logger?.(manifest.id + ': ' + message)
}

/**
 * 装配入口:按类型交付当前使用的内容,形状与内核的装配参数一致。
 * 只影响之后的请求,已经发出的请求不受影响。
 */
export const setActiveContents = (contents: AssetContents): void => {
  activeContents = contents
}

/**
 * 从插件存储读取当前使用快照并装配。
 *
 * 装配只读快照:激活时先把内容清空,快照合法才交付;没有快照或快照不合法都保持空内容,
 * 请求按原样发出,不阻断激活,也不做部分保留。激活之后由 setActiveContents 与导入入口
 * 替换内容,下一次激活重新以快照为准。
 */
const loadSnapshot = (): void => {
  setActiveContents({})

  const target = storage
  if (target === null) return

  let raw: unknown
  try {
    raw = target.get(SNAPSHOT_STORAGE_KEY)
  } catch (error) {
    log('读取当前使用快照失败,保持空内容: ' + describeError(error))
    return
  }

  if (raw === null || raw === undefined) {
    log('未找到当前使用快照(' + SNAPSHOT_STORAGE_KEY + '),保持空内容')
    return
  }

  const result = readActiveSnapshot(raw)
  if (!result.ok) {
    log('当前使用快照不可用(' + result.error.code + '),保持空内容: ' + result.error.message)
    return
  }

  setActiveContents(result.snapshot.contents)
  log('已从当前使用快照装配 ' + Object.keys(result.snapshot.contents).length + ' 类内容')
}

/** 资产包导入结果:成功给出包与是否已写入快照,失败给出内核的读取错误 */
export type AssetImportResult =
  | { ok: true; asset: AssetPackage; persisted: boolean }
  | { ok: false; error: AssetLoadError }

/**
 * 显式导入一份资产包文档(JSON 文本),供将来的界面调用。
 *
 * 与 setActiveContents 的分工:这一条走完整的读取与校验,成功才替换当前使用的内容,
 * 并在已激活时把同一份内容写进当前使用快照;写入失败不回滚内存里的装配结果,
 * 只把 persisted 置为 false 并写日志,因为请求已经能按新内容改写。
 * 未激活时只装配到内存,下次激活会重新读快照。
 */
export const importAssetPackage = (jsonText: string): AssetImportResult => {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText) as unknown
  } catch {
    return { ok: false, error: { code: 'invalid-json', message: '资产包文档不是合法 JSON' } }
  }

  const result = readAssetPackage(parsed)
  if (!result.ok) return { ok: false, error: result.error }

  const asset = result.asset
  setActiveContents(asset.contents)

  const target = storage
  if (target === null) {
    log('导入资产包 ' + asset.source.id + ',当前未激活,只装配到内存')
    return { ok: true, asset, persisted: false }
  }

  try {
    target.set(SNAPSHOT_STORAGE_KEY, createSnapshot(asset.contents))
    log('导入资产包 ' + asset.source.id + ',已写入当前使用快照')
    return { ok: true, asset, persisted: true }
  } catch (error) {
    log('导入资产包 ' + asset.source.id + ',已装配但写入快照失败: ' + describeError(error))
    return { ok: true, asset, persisted: false }
  }
}

/**
 * 启动入口,引擎在激活时调用,超时 5 秒。
 * 返回值被忽略,不要用它传递释放函数。
 */
export const activate = (context: PluginContext): void => {
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

  // 先取快照再登记处理器:处理器每次请求重新读取 activeContents,顺序不影响结果,
  // 但先装配能让激活日志与首次请求看到同一份内容
  loadSnapshot()

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
  storage = null
  logger = null
  active = false
}
