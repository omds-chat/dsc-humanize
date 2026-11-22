/**
 * overlay.notice 的常驻通知:资产来源不可达或资产包不可用时说明原因。
 *
 * 口径:
 * - 只在有实际问题时登记;两个问题都解决时撤销登记,正常状态不留任何卡片。
 * - 一条即可:同一插件的多条 overlay.notice 会被宿主合并成一张按插件分组的卡片,
 *   这里只登记一条「资产状态」,把当前所有原因写在同一段正文里,不做逐条罗列。
 * - 来源「还没取件」不算不可达:只有真的取了且全失败才算(取件通道缺失同样算),
 *   否则插件刚激活就会误报一次,用户看到的是还没开始就失败。
 * - 正文用直给文案(text),不走宿主文案键:原因里带错误码与地址,字典键承载不了;
 *   宿主对 text 的上限是 2000 字符,这里按该上限收敛。
 * - 只提示不阻断:通知不改请求、不拦安装,请求前处理器照自己的判据决定改不改。
 */
import type { AssetContents } from '../humanize/types.js'
import type { PluginSlotOverlayNoticeDescriptor } from '../types.js'

/** 登记落点:右上角的全局面板通知栈 */
export const ASSET_NOTICE_SLOT = 'overlay.notice'

/** 通知的槽位 id;同 id 重新登记即替换(正文变化时按此刷新) */
export const ASSET_NOTICE_ID = 'asset-state'

/** 强度:两个原因都属于「功能暂不可用」,用 warning,不用 error(插件本身没坏) */
export const ASSET_NOTICE_LEVEL = 'warning'

/** 通知栈内的排序键 */
export const ASSET_NOTICE_ORDER = 50

/** 宿主对通知正文的上限(引擎 pluginSlots.ts 的 MAX_PAGE_TEXT_LENGTH) */
export const ASSET_NOTICE_MAX_TEXT = 2000

/** 原因里错误摘要的截断长度;错误码与一段可读文本足够定位 */
const REASON_MAX_LENGTH = 160

export type AssetNoticeLocale = 'zh-CN' | 'en-US'

/**
 * 来源可达性结论。
 * unknown 表示还没有任何取件结论(尚未取件、或来源全被关掉),不当作问题;
 * unreachable 才登记通知,reason 是给人看的原因摘要。
 */
export type AssetSourceReachability =
  | { readonly status: 'unknown' }
  | { readonly status: 'reachable' }
  | { readonly status: 'unreachable'; readonly reason: string }

/** 通知构建的输入:当前装配内容、来源结论与界面语言 */
export interface AssetNoticeInput {
  readonly contents: AssetContents
  readonly sources: AssetSourceReachability
  readonly locale?: AssetNoticeLocale
}

/**
 * 资产包可用性的缺口。
 * empty:五类条目一条都没有(包为空);
 * missing:有内容但缺改写链路的前置(标签集或策略表),改写同样不会生效。
 */
export interface AssetContentGap {
  readonly empty: boolean
  readonly missing: readonly ('labels' | 'strategies')[]
}

const countItems = (content: { readonly items: readonly unknown[] } | undefined): number =>
  content === undefined ? 0 : content.items.length

/**
 * 判断当前装配内容是否够改写用。
 * 请求前处理器的前置就是「有标签集且有策略表」,这里用同一判据,
 * 避免通知说「可用」而请求实际没被改写。
 */
export const inspectAssetContents = (contents: AssetContents): AssetContentGap => {
  const counts = {
    persona: countItems(contents.persona),
    labels: countItems(contents.labels),
    strategies: countItems(contents.strategies),
    injection: countItems(contents.injection),
    examples: countItems(contents.examples),
  }
  const empty = counts.persona + counts.labels + counts.strategies + counts.injection + counts.examples === 0
  if (empty) return { empty: true, missing: [] }
  const missing: ('labels' | 'strategies')[] = []
  if (counts.labels === 0) missing.push('labels')
  if (counts.strategies === 0) missing.push('strategies')
  return { empty: false, missing }
}

const clampText = (text: string, limit: number): string => {
  const chars = [...text]
  return chars.length <= limit ? text : chars.slice(0, limit - 1).join('') + '…'
}

/** 正文片段:按语言取一侧;reason 原样嵌入(已截断) */
const sourceClause = (locale: AssetNoticeLocale, reason: string): string =>
  locale === 'en-US'
    ? 'Asset sources are unreachable (' + reason + '): browsing and installing are unavailable, already assembled assets still apply'
    : '资产来源暂不可达(' + reason + '):目录浏览与安装不可用,已装配的资产包照常生效'

const emptyClause = (locale: AssetNoticeLocale): string =>
  locale === 'en-US'
    ? 'No asset package is available: humanizing does not take effect and requests go out unchanged; install one from the asset market tab'
    : '当前没有可用的资产包:人性化改写不生效,请求按原样发出;可在资产市场标签里安装一份资产包'

const incompleteClause = (locale: AssetNoticeLocale, missing: readonly ('labels' | 'strategies')[]): string => {
  if (locale === 'en-US') {
    const names = missing.map((item) => (item === 'labels' ? 'label set' : 'strategy table')).join(', ')
    return 'The asset package is incomplete (missing ' + names + '): humanizing does not take effect and requests go out unchanged'
  }
  const names = missing.map((item) => (item === 'labels' ? '标签集' : '策略表')).join('、')
  return '资产包内容不完整(缺少' + names + '):人性化改写不生效,请求按原样发出'
}

/**
 * 构建一条资产状态通知;没有问题返回 null(调用方据此撤销登记)。
 *
 * 纯函数:不读宿主、不读设置,输入即事实,便于用夹具覆盖各种组合。
 * 两个原因同时成立时合成一段正文,仍然只登记一条。
 */
export const buildAssetNotice = (input: AssetNoticeInput): PluginSlotOverlayNoticeDescriptor | null => {
  const locale = input.locale ?? 'zh-CN'
  const gap = inspectAssetContents(input.contents)
  const unreachable = input.sources.status === 'unreachable' ? input.sources.reason : null
  if (unreachable === null && gap.empty === false && gap.missing.length === 0) return null

  const clauses: string[] = []
  if (unreachable !== null) {
    clauses.push(sourceClause(locale, clampText(unreachable, REASON_MAX_LENGTH)))
  }
  if (gap.empty) {
    clauses.push(emptyClause(locale))
  } else if (gap.missing.length > 0) {
    clauses.push(incompleteClause(locale, gap.missing))
  }

  const separator = locale === 'en-US' ? '; ' : ';'
  return {
    id: ASSET_NOTICE_ID,
    level: ASSET_NOTICE_LEVEL,
    order: ASSET_NOTICE_ORDER,
    text: clampText(clauses.join(separator), ASSET_NOTICE_MAX_TEXT),
  }
}
