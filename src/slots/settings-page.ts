/**
 * settings.page 槽位:资产来源设置页(设置 → 插件 → 资产来源)的描述模型与保存口径。
 *
 * 槽位语义以宿主引擎文档为准:settings.page 是页面型槽位,系统设置的「插件」分组只在
 * 有登记项时出现;登记一项 = 设置页里的一个入口,点击后在同一分组内渲染该页面的区块模型。
 * 区块复用 ui:slot 的四种类型,表单区块的字段与 settings:surface 同源
 * (直接复用 marketSettingDescriptor.fields,两个表面不会各自漂移)。
 *
 * 保存口径(与资产市场标签里的来源表单一致的既有口径):
 * - 表单值的生命周期归宿主:改动即脏、离开页面丢弃,动作按钮触发时宿主把草稿随载荷交给插件;
 * - 本页的「保存来源配置」动作是唯一的落盘动作:草稿收敛成设置字段的值,写进插件存储的
 *   版本化记录(SETTINGS_PAGE_STORAGE_KEY),写入后立即参与来源解析,下一次取件生效;
 * - 存储里的值优先于 settings:surface 登记的字段值。理由:插件侧的设置面只读
 *   (context.settings 只有 register 与 values),读不到宿主的「是否被用户覆盖」,
 *   只有一份可写的生效值才能让两个表面读到同一份配置,而不是各读一半。
 */
import { marketSettingDescriptor, SETTING_KEYS } from '../market/sources.js'
import type {
  PluginSettingFieldDescriptor,
  PluginSettingValue,
  PluginSlotDescriptor,
} from '../types.js'

/** 槽位名;与清单 slots 白名单、宿主 SLOT_NAMES 枚举一致 */
export const SETTINGS_PAGE_SLOT = 'settings.page' as const

/** 页面 id;同一槽位内跨插件唯一 */
export const SETTINGS_PAGE_ID = 'asset-sources'

/** 排序权重;设置分组里排在其他插件页之后由宿主按 order 升序决定,这里取 100 */
export const SETTINGS_PAGE_ORDER = 100

/** 页面标题的 zh/en 词条,成对登记;宿主按界面语言取一侧 */
export const SETTINGS_PAGE_LABELS = {
  'zh-CN': '资产来源',
  'en-US': 'Asset sources',
} as const

export type SettingsPageLocale = keyof typeof SETTINGS_PAGE_LABELS

/** 保存动作键;ui:slot-action 回调时作为 actionId 交回插件 */
export const SAVE_SOURCES_ACTION_KEY = 'save-sources'

/** 保存动作的按钮文案,与标题同样成对 */
export const SAVE_SOURCES_LABELS = {
  'zh-CN': '保存来源配置',
  'en-US': 'Save source settings',
} as const

/**
 * 保存记录的存储键与版本。
 * 与快照(IndexedDB)、安装记录(dsc-humanize/market/v1)、人性化开关
 * (dsc-humanize/rewrite/v1)分开:四份数据的生命周期不同,混用会出现
 * 「清理安装记录顺带丢掉来源配置」这类副作用。
 */
export const SETTINGS_PAGE_STORAGE_KEY = 'dsc-humanize/asset-sources/v1'

/** 记录版本;版本不符按「没有保存值」处理,不做部分保留 */
export const SETTINGS_PAGE_RECORD_VERSION = 1

/** 保存记录的存储形状 */
export interface AssetSourcesRecord {
  readonly version: number
  readonly values: Record<string, PluginSettingValue>
}

/**
 * 本页说明文字。
 *
 * 讲清三件事,守既有口径不自造新规矩:改动即时生效、草稿不落盘、保存走本页的保存动作;
 * 末尾补一句目录缓存时长,免得用户保存后看不到变化时以为没生效。
 */
export const SETTINGS_PAGE_NOTE =
  '来源配置与资产市场标签里的「来源」表单是同一份字段:页面内的改动由宿主表单模型承接,随动作载荷交给插件,对本次会话的取件与安装即时生效但不落盘;点击「保存来源配置」才写入插件设置,并在下一次取件时生效(目录在内存缓存 5 分钟,刷新目录会绕过缓存重新取件)。'

/** 设置字段键的集合;表单草稿与存储记录都只认这几个键 */
const SETTING_KEY_SET: ReadonlySet<string> = new Set(Object.values(SETTING_KEYS))

const isSettingValue = (value: unknown): value is PluginSettingValue =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

/** 只保留设置字段键与标量值;未知键与其他形态一并丢弃,不做类型转换 */
const filterSettingValues = (source: Record<string, unknown>): Record<string, PluginSettingValue> => {
  const values: Record<string, PluginSettingValue> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!SETTING_KEY_SET.has(key)) continue
    if (!isSettingValue(value)) continue
    values[key] = value
  }
  return values
}

/**
 * 收敛动作载荷里的表单草稿:只保留设置字段的键与标量值。
 * 返回 null 表示没有可用值(载荷不带 form,或键全部不认识),调用方据此不写存储。
 */
export const readSourcesFormValues = (
  form: Record<string, unknown> | undefined,
): Record<string, PluginSettingValue> | null => {
  if (form === undefined) return null
  const values = filterSettingValues(form)
  return Object.keys(values).length > 0 ? values : null
}

/** 把一份保存值写成版本化记录 */
export const createAssetSourcesRecord = (
  values: Record<string, PluginSettingValue>,
): AssetSourcesRecord => ({
  version: SETTINGS_PAGE_RECORD_VERSION,
  values: filterSettingValues(values),
})

/**
 * 读取存储里的保存值;键缺失、形状不符或版本不符都返回 null(回落到宿主设置值),
 * 与人性化开关的读取口径一致:不做部分保留,也不猜旧版本的字段含义。
 */
export const readAssetSourcesRecord = (
  raw: unknown,
): Record<string, PluginSettingValue> | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as { version?: unknown; values?: unknown }
  if (record.version !== SETTINGS_PAGE_RECORD_VERSION) return null
  if (typeof record.values !== 'object' || record.values === null) return null
  const values = filterSettingValues(record.values as Record<string, unknown>)
  return Object.keys(values).length > 0 ? values : null
}

/**
 * 合并出一个生效值视图:保存值优先,宿主设置值作为兜底。
 * 两处都没有值时返回 null,来源解析按字段缺省处理。
 */
export const mergeSourceValues = (
  saved: Record<string, PluginSettingValue> | null,
  host: Record<string, PluginSettingValue> | null,
): Record<string, PluginSettingValue> | null => {
  if (saved === null || Object.keys(saved).length === 0) return host
  if (host === null) return { ...saved }
  return { ...host, ...saved }
}

/** 字段类型与值是否同形;不同形时保留字段原有缺省,免得宿主按类型校验后整份拒绝 */
const matchesFieldType = (field: PluginSettingFieldDescriptor, value: PluginSettingValue): boolean => {
  if (field.type === 'switch') return typeof value === 'boolean'
  if (field.type === 'number') return typeof value === 'number'
  return typeof value === 'string'
}

/**
 * 表单字段描述:与 marketSettingDescriptor.fields 同一份字段,只把 default 换成当前生效值。
 *
 * 宿主按字段的 default 初始化页面表单草稿,回填后打开设置页看到的就是正在生效的配置;
 * 字段的键、类型、标签、长度与正则一律沿用设置表面的描述,不另写一份。
 */
export const settingsPageFields = (
  values: Record<string, PluginSettingValue> | null,
): readonly PluginSettingFieldDescriptor[] =>
  marketSettingDescriptor.fields.map((field) => {
    if (values === null) return field
    // secret 字段不得带缺省值(宿主按 invalid-default 拒绝整份描述),这里也不回填
    if (field.type === 'secret') return field
    const value = values[field.key]
    if (value === undefined || !matchesFieldType(field, value)) return field
    return { ...field, default: value }
  })

/**
 * 构建资产来源设置页的槽位描述。
 *
 * 区块顺序:form(来源配置)→ text(保存口径说明)→ actions(保存来源配置)。
 * 表单在前是因为说明与按钮都在说这份表单;按钮必须放在表单之后,
 * 宿主只在动作回调里带上表单草稿,没有动作按钮就没有提交入口。
 */
export const buildSettingsPageDescriptor = (
  locale: SettingsPageLocale = 'zh-CN',
  values: Record<string, PluginSettingValue> | null = null,
): PluginSlotDescriptor => ({
  id: SETTINGS_PAGE_ID,
  title: SETTINGS_PAGE_LABELS[locale],
  order: SETTINGS_PAGE_ORDER,
  blocks: [
    { id: 'sources', type: 'form', fields: settingsPageFields(values) },
    { id: 'save-note', type: 'text', text: SETTINGS_PAGE_NOTE },
    {
      id: 'page-actions',
      type: 'actions',
      items: [{ key: SAVE_SOURCES_ACTION_KEY, label: SAVE_SOURCES_LABELS[locale] }],
    },
  ],
})
