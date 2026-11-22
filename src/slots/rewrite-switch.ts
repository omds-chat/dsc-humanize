/**
 * 「是否启用资产改写」开关:存储键、读取口径与 composer.toolbar 按钮描述。
 *
 * 开关状态存插件存储,键与既有两份持久数据分开:
 * - 快照走 IndexedDB(过渡期旧键 dsc-humanize/snapshot/v1 只用于一次性迁移);
 * - 市场安装记录走 dsc-humanize/market/v1。
 * 三份数据的生命周期不同,混用一个键会出现「清理市场记录顺带关掉改写」这类副作用,
 * 因此开关单独占一个键,且只在开关动作里读写。
 *
 * 缺口与取舍:宿主 composer.toolbar 的描述只有一个文案字段(labelKey 或 label),
 * 没有独立的徽标位,因此状态并入文案:「人性化 · 开」「人性化 · 关」。
 * 点击后的气泡用宿主文案键 REWRITE_TOGGLE_NOTICE_KEY,带 {state} 参数;
 * 宿主字典没有该键时,宿主 i18n 的缺键口径是回落为键名本身(插件探测不到字典)。
 */
import type { PluginSlotToolbarDescriptor } from '../types.js'

/** 登记落点:输入框下方的工具条 */
export const REWRITE_SWITCH_SLOT = 'composer.toolbar'

/** 按钮的槽位 id;同 id 重新登记即替换(宿主对同插件同 id 采取替换语义) */
export const REWRITE_BUTTON_ID = 'rewrite-switch'

/** 动作键;点击时作为载荷的 actionId 回到插件 */
export const REWRITE_ACTION_KEY = 'toggle'

/**
 * 开关在插件存储里的键。
 * 值形状是 RewriteSwitchRecord(版本 + 布尔值),读到别的版本按缺省处理。
 */
export const REWRITE_SWITCH_STORAGE_KEY = 'dsc-humanize/rewrite/v1'

/** 存储记录的版本;形状变化时递增 */
export const REWRITE_SWITCH_VERSION = 1

/** 缺省值:开启。已安装用户的既有行为(有资产就改写请求)不因升级改变 */
export const REWRITE_SWITCH_DEFAULT = true

/** 工具条内的排序键;与资产市场标签(50)同一套排期约定 */
export const REWRITE_BUTTON_ORDER = 50

/** 宿主语言;与资产市场标签共用 zh/en 成对词条的口径 */
export type RewriteSwitchLocale = 'zh-CN' | 'en-US'

/** 按钮文案:文案在前、状态在后,宿主按纯文本渲染(没有徽标位) */
const BUTTON_LABELS = {
  'zh-CN': { on: '人性化 · 开', off: '人性化 · 关' },
  'en-US': { on: 'Humanize · on', off: 'Humanize · off' },
} as const

/** 气泡里的状态词 */
const STATE_WORDS = {
  'zh-CN': { on: '开启', off: '关闭' },
  'en-US': { on: 'on', off: 'off' },
} as const

/**
 * 点击后的气泡文案键(宿主字典)。
 * 宿主需提供一条形如「人性化改写已{state}」的词条;缺键时宿主回落到键名本身。
 */
export const REWRITE_TOGGLE_NOTICE_KEY = 'pluginToggleApplied'

/** 存储记录的形状 */
export interface RewriteSwitchRecord {
  readonly version: number
  readonly enabled: boolean
}

/** 由开关值生成要落盘的记录 */
export const createRewriteSwitchRecord = (enabled: boolean): RewriteSwitchRecord => ({
  version: REWRITE_SWITCH_VERSION,
  enabled,
})

/**
 * 读取存储里的开关值。
 * 缺键(null/undefined)、形状不符或版本不符都回落到缺省(开启),不做部分保留:
 * 开关只有两种取值,读不懂的记录按「没设置过」处理最可预期。
 */
export const readRewriteSwitch = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return REWRITE_SWITCH_DEFAULT
  }
  const record = value as { version?: unknown; enabled?: unknown }
  if (record.version !== REWRITE_SWITCH_VERSION) return REWRITE_SWITCH_DEFAULT
  return typeof record.enabled === 'boolean' ? record.enabled : REWRITE_SWITCH_DEFAULT
}

/**
 * composer.toolbar 的登记描述(不带 slot,落点由 registerSlot 的第一个实参给出)。
 * 文案随开关取一侧,因此「切换后重新登记」就等于刷新按钮上的状态;
 * 描述里没有状态字段,宿主也不读插件内部状态。
 */
export const buildRewriteButtonDescriptor = (
  locale: RewriteSwitchLocale,
  enabled: boolean,
): PluginSlotToolbarDescriptor => ({
  id: REWRITE_BUTTON_ID,
  label: enabled ? BUTTON_LABELS[locale].on : BUTTON_LABELS[locale].off,
  order: REWRITE_BUTTON_ORDER,
  actionKey: REWRITE_ACTION_KEY,
})

/** 一次切换后的气泡参数:状态词随宿主语言取一侧 */
export const rewriteToggleNoticeParams = (
  locale: RewriteSwitchLocale,
  enabled: boolean,
): { state: string } => ({
  state: enabled ? STATE_WORDS[locale].on : STATE_WORDS[locale].off,
})
