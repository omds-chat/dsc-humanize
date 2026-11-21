import { createBeforeRequestHandler } from './host/request-patch.js'
import { KERNEL_VERSION } from './humanize/index.js'
import type { AssetContents } from './humanize/types.js'
import { manifest } from './manifest.js'
import type { PluginContext } from './types.js'

export { manifest }
export * from './humanize/index.js'

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
 * 由装配方选定资产后交给 setActiveContents;未交付时为空,请求保持原样。
 */
let activeContents: AssetContents = {}

/**
 * 装配入口:按类型交付当前使用的内容,形状与内核的装配参数一致。
 * 只影响之后的请求,已经发出的请求不受影响。
 */
export const setActiveContents = (contents: AssetContents): void => {
  activeContents = contents
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
  context.log(
    manifest.id + ': activated, kernel ' + KERNEL_VERSION + ', capabilities ' + manifest.capabilities.join(', '),
  )

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
 * 只丢弃本地引用并复位插件自身的状态。当前使用的内容属于用户配置,跨停用保留。
 */
export const deactivate = (): void => {
  // 释放函数由引擎自动执行,这里不重复调用,只丢弃本地引用
  if (releaseSessionSubscription !== null) {
    releaseSessionSubscription = null
  }
  if (releaseRequestHandler !== null) {
    releaseRequestHandler = null
  }
  active = false
}
