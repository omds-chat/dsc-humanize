/**
 * 资产市场 slot 描述的模型构建层(ui:slot 消费层,设计 asset-market.md 8.1 的落地形态)。
 *
 * 宿主约定:插件只交描述、不交控件,slot 模型是声明式的 SlotDescriptor;
 * 数据挂载点同步返回模型,所以这里只做「取件结果 -> 模型」的纯转换,
 * 异步取件与缓存由 src/index.ts 的接线层负责。
 *
 * 模型构成(任务口径):
 * - text 区块:两轴结论说明一句(来源是否可信与签名是否通过各管一条轴),外加
 *   一句来源表单的保存口径说明;
 * - list 区块「目录」:按已启用来源列出各合集的包(标题=包名、描述=作者与类型集合、
 *   徽标=来源名),逐条动作「安装」;取件失败的来源折叠为一行说明,徽标标
 *   「来源不可用」,列表不空(设计 6.1:只提示不阻断);
 * - form 区块「来源」:与设置表面字段同源(直接复用 marketSettingDescriptor.fields,
 *   两个表面不会各自漂移),取舍理由见 README「资产市场」节;
 * - actions 区块:「刷新目录」动作。
 *
 * 条目键与包身份的对应关系由条目登记表(entries)承载:条目键用生成的安全键
 * (pkg-<序号>),作者与包标识可能含键词表之外的字符,不能直接进条目键;
 * 动作回调按 itemKey 查表还原参数。目录超过宿主描述体积上限(8KB)时从尾部
 * 收敛条目并置 truncated,尾部补一条截断说明(装得下才补)。
 */
import { marketSettingDescriptor } from './sources.js'
import type { CatalogResult } from './catalog.js'
import type { MarketSource } from './sources.js'
import type {
  PluginSlotDescriptor,
  PluginSlotListItemDescriptor,
  PluginSettingValue,
} from '../types.js'

/** 资产市场登记的挂载点:会话视图标签栏里的一个标签 + 主区整页 */
export const MARKET_SLOT = 'conversation.tabs'

/** 条目 id;同一 slot 内不得重复 */
export const MARKET_SLOT_ID = 'asset-market'

/** 条目标题的 zh/en 词条,成对登记;宿主按界面语言取一侧 */
export const MARKET_SLOT_LABELS = {
  'zh-CN': '资产市场',
  'en-US': 'Asset market',
} as const

export type MarketSlotLocale = keyof typeof MARKET_SLOT_LABELS

/** 逐条动作键:安装 */
export const INSTALL_ACTION_KEY = 'install'

/** actions 区块动作键:刷新目录 */
export const REFRESH_ACTION_KEY = 'refresh'

/**
 * 目录的内存短缓存时长。口径对齐设计 8.1 的建议(目录缓存只在内存、5 分钟):
 * 进入条目先显示缓存,「刷新目录」动作绕过缓存重新取件,避免把 assets:read 的
 * 20 次 / 10 秒与 settings:surface 的 60 次 / 10 秒预算耗在重复取件上。
 */
export const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000

/** 来源不可用时的徽标文案(任务口径) */
export const SOURCE_UNAVAILABLE_BADGE = '来源不可用'

/** 目录尚未取到时的徽标文案(第一次进入条目、后台正在取件) */
export const SOURCE_PENDING_BADGE = '读取中'

/** 截断说明条目的键、标题与说明 */
const TRUNCATED_ITEM_KEY = 'pkg-truncated'
const TRUNCATED_ITEM_TITLE = '目录已截断'
const TRUNCATED_ITEM_DESCRIPTION =
  '条目超过宿主描述的体积上限,已隐藏尾部条目;可用刷新目录重新取件或缩小已启用的来源范围。'

/** 宿主侧的文案上限(引擎 pluginPages.ts):标题与徽标 40,说明 200,条目至多 200 */
const MAX_LABEL_LENGTH = 40
const MAX_DESCRIPTION_LENGTH = 200
const MAX_LIST_ITEMS = 200
const MAX_DESCRIPTOR_BYTES = 8 * 1024

/** 条目键的词表,与宿主 PAGE_KEY_PATTERN(即 SETTING_KEY_PATTERN)一致 */
const ITEM_KEY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

/** 一个目录条目还原出的安装参数;动作回调按条目键查这张表 */
export interface MarketPageEntry {
  /** 条目键,安全的生成键 */
  readonly key: string
  readonly sourceId: string
  readonly author: string
  readonly packageId: string
}

/** 数据挂载点交给模型构建层的一个来源取件结果 */
export type MarketPageSourceResult =
  | { readonly source: MarketSource; readonly catalog: Extract<CatalogResult, { ok: true }> }
  | { readonly source: MarketSource; readonly error: { readonly code: string; readonly message: string } }
  /** 尚未取到(缓存为空、后台正在取件) */
  | { readonly source: MarketSource; readonly pending: true }

/** 一次模型构建的结果:slot 描述、条目登记表与是否发生截断 */
export interface MarketPageModel {
  readonly descriptor: PluginSlotDescriptor
  /** 可安装条目的登记表,动作回调按条目键查表还原安装参数 */
  readonly entries: readonly MarketPageEntry[]
  /** 目录因体积上限被收敛时为 true */
  readonly truncated: boolean
}

const clampLabel = (text: string): string => {
  const chars = [...text]
  return chars.length <= MAX_LABEL_LENGTH ? text : chars.slice(0, MAX_LABEL_LENGTH).join('')
}

const clampDescription = (text: string): string => {
  const chars = [...text]
  return chars.length <= MAX_DESCRIPTION_LENGTH ? text : chars.slice(0, MAX_DESCRIPTION_LENGTH).join('')
}

const packageDescription = (entry: { author: string; types: readonly string[] }): string => {
  const types = entry.types.length > 0 ? entry.types.join('、') : '未声明类型'
  return clampDescription('作者 ' + entry.author + ' · 类型 ' + types)
}

const failureDescription = (message: string): string =>
  clampDescription('该来源暂不可读,已按「只提示不阻断」处理,不影响其他来源: ' + message)

const pendingDescription =
  '目录尚未取到,已在后台按既有目录层取件;取件完成后点击刷新目录或重新进入标签查看。'

/** 两轴结论说明(text 区块):来源是否可信与签名是否通过各管一条轴 */
const TWO_AXIS_NOTE =
  '目录条目的结论分两条轴:来源是否可信由来源证书链与合集 id 的链校验给出,签名是否通过由清单验签给出,两条轴互不替代;当前合集尚未发布签名材料,签名结论恒为未校验。'

/** 来源表单的保存口径说明:表单草稿不落盘,持久保存走插件设置页 */
const SOURCE_FORM_NOTE =
  '来源表单与插件设置页的字段同源:标签内改动对本次会话的取件与安装即时生效但不落盘,持久保存请到插件设置页。目录在内存缓存 5 分钟,刷新目录会绕过缓存重新取件。'

const descriptorBytes = (descriptor: PluginSlotDescriptor): number =>
  new TextEncoder().encode(JSON.stringify(descriptor)).byteLength

/** 判断一个值是不是表单草稿里的合法设置值 */
const isSettingValue = (value: unknown): value is PluginSettingValue =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

/**
 * 收敛动作载荷里的表单草稿值:只保留设置字段的键与标量值,其余丢弃。
 * 表单区块的字段与设置表面同源,键集合一致,这里不需要知道具体键名。
 */
export const readPageFormValues = (
  form: Record<string, unknown> | undefined,
): Record<string, PluginSettingValue> | null => {
  if (form === undefined) return null
  const values: Record<string, PluginSettingValue> = {}
  for (const [key, value] of Object.entries(form)) {
    if (isSettingValue(value)) {
      values[key] = value
    }
  }
  return Object.keys(values).length > 0 ? values : null
}

/**
 * 由各来源的取件结果构建「资产市场」slot 描述。
 *
 * 纯函数:不取件、不读设置,输入即各来源的结果(取件失败的来源给 error,
 * 尚未取到的来源给 pending)。条目登记表按构建顺序生成安全键,动作回调层
 * 按键查表还原安装参数;同一模型内键不重复,跨模型重建时整表替换。
 */
export const buildMarketPageModel = (
  results: readonly MarketPageSourceResult[],
  locale: MarketSlotLocale = 'zh-CN',
): MarketPageModel => {
  const items: PluginSlotListItemDescriptor[] = []
  const entries: MarketPageEntry[] = []
  let nextPackageIndex = 0
  let nextNoticeIndex = 0

  for (const result of results) {
    if ('pending' in result) {
      items.push({
        key: 'src-pending-' + String(nextNoticeIndex++),
        title: clampLabel(result.source.name),
        description: pendingDescription,
        badge: SOURCE_PENDING_BADGE,
      })
      continue
    }
    if ('error' in result) {
      items.push({
        key: 'src-unavailable-' + String(nextNoticeIndex++),
        title: clampLabel(result.source.name),
        description: failureDescription(result.error.message),
        badge: SOURCE_UNAVAILABLE_BADGE,
      })
      continue
    }
    for (const pkg of result.catalog.packages) {
      const key = 'pkg-' + String(nextPackageIndex++)
      if (!ITEM_KEY_PATTERN.test(key)) {
        // 词表不会拒绝 pkg-<数字>,防御性跳过,不中断目录
        continue
      }
      items.push({
        key,
        title: clampLabel(pkg.id),
        description: packageDescription(pkg),
        badge: clampLabel(result.source.name),
      })
      entries.push({ key, sourceId: result.source.id, author: pkg.author, packageId: pkg.id })
    }
  }

  // 条目至多 200 条;超出时从尾部收敛,登记表同步裁剪
  if (items.length > MAX_LIST_ITEMS) {
    const keptItems = items.slice(0, MAX_LIST_ITEMS)
    const keptKeys = new Set(keptItems.map((item) => item.key))
    items.length = 0
    items.push(...keptItems)
    const keptEntries = entries.filter((entry) => keptKeys.has(entry.key))
    entries.length = 0
    entries.push(...keptEntries)
  }

  const makeDescriptor = (): PluginSlotDescriptor => ({
    id: MARKET_SLOT_ID,
    title: MARKET_SLOT_LABELS[locale],
    order: 50,
    blocks: [
      { id: 'overview', type: 'text', text: TWO_AXIS_NOTE + SOURCE_FORM_NOTE },
      {
        id: 'catalog',
        type: 'list',
        items,
        itemAction: { key: INSTALL_ACTION_KEY, label: '安装' },
      },
      { id: 'sources', type: 'form', fields: marketSettingDescriptor.fields },
      {
        id: 'page-actions',
        type: 'actions',
        items: [{ key: REFRESH_ACTION_KEY, label: '刷新目录' }],
      },
    ],
  })

  let descriptor = makeDescriptor()

  // 体积收敛:超过宿主 8KB 上限时从尾部丢条目,丢过就补一条截断说明(装得下才补)
  let truncated = false
  while (descriptorBytes(descriptor) > MAX_DESCRIPTOR_BYTES && entries.length > 0) {
    const dropped = entries.pop()
    if (dropped === undefined) break
    const index = items.findIndex((item) => item.key === dropped.key)
    if (index >= 0) items.splice(index, 1)
    truncated = true
    descriptor = makeDescriptor()
  }
  if (truncated) {
    // 先补截断说明,再继续收敛条目到装得下;只有零条目仍装不下才丢掉说明
    items.push({
      key: TRUNCATED_ITEM_KEY,
      title: TRUNCATED_ITEM_TITLE,
      description: TRUNCATED_ITEM_DESCRIPTION,
    })
    descriptor = makeDescriptor()
    while (descriptorBytes(descriptor) > MAX_DESCRIPTOR_BYTES && entries.length > 0) {
      const dropped = entries.pop()
      if (dropped === undefined) break
      const index = items.findIndex((item) => item.key === dropped.key)
      if (index >= 0) items.splice(index, 1)
      descriptor = makeDescriptor()
    }
    if (descriptorBytes(descriptor) > MAX_DESCRIPTOR_BYTES) {
      const index = items.findIndex((item) => item.key === TRUNCATED_ITEM_KEY)
      if (index >= 0) items.splice(index, 1)
      descriptor = makeDescriptor()
    }
  }

  return { descriptor, entries, truncated }
}
