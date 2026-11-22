/**
 * 市场来源模型(设计 asset-market.md 第二节)。
 *
 * 一个来源由「一组 base_url + 合集 id」共同标识,缺一不可(2.1):
 * 地址决定从哪里取件,合集 id 决定取哪张证书、结论归属到谁。
 * 内置两条来源(dsc-humanize-inner-asset 与 awesome-dsc-humanize-asset),
 * 不可删除,base_url 列表与顺序可以随部署事实调整;用户自建来源与内置同形,
 * 本轮最多支持一条(上限),经设置表面字段存储,来源开关只覆盖两条内置来源。
 *
 * 本地联调地址由构建注入(2.2):.env 里的两个链接变量经 build.mjs define
 * 写进产物常量,注入值非法时退回线上地址;地址判定与信任校验不分开发与线上。
 */
import type { PluginSettingDescriptor, PluginSettingValue } from '../types.js'

/** 内置来源的合集 id;同时是证书目录名与结论归属(2.1、3.2) */
export const INNER_ASSET_COLLECTION_ID = 'dsc-humanize-inner-asset'
export const AWESOME_ASSET_COLLECTION_ID = 'awesome-dsc-humanize-asset'

/** 线上分发的 base_url,顺序即默认优先级(2.2) */
const INNER_PRODUCTION_BASE_URLS = ['https://omds-chat.github.io/dsc-humanize-inner-asset/']
const AWESOME_PRODUCTION_BASE_URLS = [
  'https://cdn.jsdelivr.net/gh/omds-chat/awesome-dsc-humanize-asset@main/',
  'https://raw.githubusercontent.com/omds-chat/awesome-dsc-humanize-asset/main/',
  'https://omds-chat.github.io/awesome-dsc-humanize-asset/',
]

/** 读取构建期注入的本地联调地址;未经构建直接运行源码时该标识不存在,按未注入处理 */
const readInjectedInnerUrl = (): string =>
  typeof __INNER_ASSET_PAGES_URL__ === 'string' ? __INNER_ASSET_PAGES_URL__ : ''

const readInjectedAwesomeUrl = (): string =>
  typeof __AWESOME_ASSET_PAGES_URL__ === 'string' ? __AWESOME_ASSET_PAGES_URL__ : ''

/** 合集 id 的取值规则,与合集目录名一致(2.1) */
const COLLECTION_ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/

const LOOPBACK_HTTP_HOST_PATTERN =
  /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i

/**
 * 地址判定(2.5):允许 https 任意主机,或 http 的回环地址;
 * 写入前统一去掉查询与哈希,并补齐尾部斜杠。
 * 这套判定与引擎的插件来源判定同口径,本地地址不享受任何例外之外的放宽。
 */
export const normalizeSourceBaseUrl = (raw: string): string | null => {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol === 'https:') {
    // https 任意主机
  } else if (parsed.protocol === 'http:' && LOOPBACK_HTTP_HOST_PATTERN.test(trimmed)) {
    // http 只放行回环地址
  } else {
    return null
  }
  // 去掉查询与哈希,补齐尾部斜杠
  parsed.hash = ''
  parsed.search = ''
  const withoutQuery = parsed.toString()
  return withoutQuery.endsWith('/') ? withoutQuery : withoutQuery + '/'
}

/** 市场来源:内置与自建同形,不因出处获得特权字段(2.3) */
export interface MarketSource {
  /** 合集 id;同一 id 只能有一条来源 */
  readonly id: string
  /** 展示名,供将来的界面与日志使用 */
  readonly name: string
  /** base_url 列表,按顺序尝试(3.1) */
  readonly baseUrls: readonly string[]
  /** 是否内置;内置不可删除 */
  readonly builtin: boolean
  /** 是否参与取件;关闭的来源不发起任何请求 */
  readonly enabled: boolean
}

/** 设置表面字段的键,与登记给宿主的描述一致;键须过宿主 SETTING_KEY_PATTERN(不含下划线) */
export const SETTING_KEYS = {
  innerSourceEnabled: 'inner-asset-source',
  awesomeSourceEnabled: 'awesome-asset-source',
  customSourceUrl: 'custom-asset-source-url',
  customSourceId: 'custom-asset-source-id',
} as const

/**
 * 登记给宿主的设置字段描述:内置两来源各一个开关,自建来源一对文本(URL 与合集 id)。
 * 标签用插件直给文案:宿主当前没有资产来源对应的既有文案键;宿主提供文案键后应切换 labelKey。
 * 本轮最多支持一条自建来源,字段形状即上限;扩到多条属表面字段与取件顺序的后续变更。
 */
export const marketSettingDescriptor: PluginSettingDescriptor = {
  fields: [
    {
      key: SETTING_KEYS.innerSourceEnabled,
      type: 'switch',
      label: '启用内置来源:组织预设资产包',
      default: true,
    },
    {
      key: SETTING_KEYS.awesomeSourceEnabled,
      type: 'switch',
      label: '启用内置来源:社区资产包',
      default: true,
    },
    {
      key: SETTING_KEYS.customSourceUrl,
      type: 'text',
      label: '自建来源地址(https 或回环 http)',
      default: '',
      maxLength: 500,
    },
    {
      key: SETTING_KEYS.customSourceId,
      type: 'text',
      label: '自建来源合集 id',
      default: '',
      maxLength: 64,
      pattern: '^$|^[a-z][a-z0-9-]{2,63}$',
    },
  ],
}

/** 开关值的读取口径:布尔按原值,其余形态按缺省处理,不做部分保留之外的猜测 */
const readSwitch = (values: Record<string, PluginSettingValue> | null, key: string): boolean => {
  if (values === null) return true
  const value = values[key]
  return typeof value === 'boolean' ? value : true
}

const readText = (values: Record<string, PluginSettingValue> | null, key: string): string => {
  if (values === null) return ''
  const value = values[key]
  return typeof value === 'string' ? value : ''
}

/** 来源解析结果:来源清单加逐条忽略原因,notes 供日志与将来的界面复用 */
export type ResolvedSources = {
  sources: readonly MarketSource[]
  notes: readonly string[]
}

/**
 * 按设置值解析当前生效的来源清单。
 *
 * 顺序固定:内置两条在前(列表顺序即默认优先级,2.2),自建来源排在其后。
 * 关闭的来源保留在清单里但 enabled 为 false,取件层据此跳过,不发任何请求;
 * 自建来源的 URL 与合集 id 必须成对填写(2.1:两部分缺一不可),缺一半则整条忽略;
 * 合集 id 与已有来源(含内置)同 id 时拒绝(2.3),地址不合法时同样忽略。
 * 每一条忽略都记进 notes,不静默丢弃。
 */
/**
 * 注入地址合法时只用它一份，不保留线上兜底，避免本地联调仍去请求外网；
 * 注入值缺失或非法时退回线上列表，fallsBack 标记这次退回以便记进 notes。
 */
const resolveBaseUrls = (
  injected: string,
  online: readonly string[]
): { urls: string[]; fallsBack: boolean } => {
  const local = normalizeSourceBaseUrl(injected)
  if (local !== null) {
    return { urls: [local], fallsBack: false }
  }
  return { urls: [...online], fallsBack: injected.trim() !== '' }
}

export const resolveMarketSources = (values: Record<string, PluginSettingValue> | null): ResolvedSources => {
  const notes: string[] = []
  const sources: MarketSource[] = []

  const inner = resolveBaseUrls(readInjectedInnerUrl(), INNER_PRODUCTION_BASE_URLS)
  if (inner.fallsBack) {
    notes.push('内置来源 ' + INNER_ASSET_COLLECTION_ID + ' 的注入地址非法,已退回线上地址')
  }
  sources.push({
    id: INNER_ASSET_COLLECTION_ID,
    name: '组织预设资产包',
    baseUrls: inner.urls,
    builtin: true,
    enabled: readSwitch(values, SETTING_KEYS.innerSourceEnabled),
  })

  const awesome = resolveBaseUrls(readInjectedAwesomeUrl(), AWESOME_PRODUCTION_BASE_URLS)
  if (awesome.fallsBack) {
    notes.push('内置来源 ' + AWESOME_ASSET_COLLECTION_ID + ' 的注入地址非法,已退回线上地址')
  }
  sources.push({
    id: AWESOME_ASSET_COLLECTION_ID,
    name: '社区资产包',
    baseUrls: awesome.urls,
    builtin: true,
    enabled: readSwitch(values, SETTING_KEYS.awesomeSourceEnabled),
  })

  const customUrl = readText(values, SETTING_KEYS.customSourceUrl)
  const customId = readText(values, SETTING_KEYS.customSourceId)
  if (customUrl.trim() === '' && customId.trim() === '') {
    return { sources, notes }
  }
  if (customUrl.trim() === '' || customId.trim() === '') {
    notes.push('自建来源的地址与合集 id 必须成对填写,当前只填了一半,整条忽略')
    return { sources, notes }
  }

  if (!COLLECTION_ID_PATTERN.test(customId.trim())) {
    notes.push('自建来源合集 id 不合法(小写字母开头,只含小写字母、数字与连字符,长度 3 到 64): ' + customId.trim())
    return { sources, notes }
  }
  const builtinIds = sources.map((source) => source.id)
  if (builtinIds.includes(customId.trim())) {
    notes.push('自建来源合集 id 与内置来源相同,拒绝新增: ' + customId.trim())
    return { sources, notes }
  }
  const customBaseUrl = normalizeSourceBaseUrl(customUrl)
  if (customBaseUrl === null) {
    notes.push('自建来源地址不合法(https 任意主机,或 http 回环地址): ' + customUrl.trim())
    return { sources, notes }
  }

  sources.push({
    id: customId.trim(),
    name: '自建来源',
    baseUrls: [customBaseUrl],
    builtin: false,
    enabled: true,
  })

  return { sources, notes }
}

/** 内置来源的 id 集合,供自建来源查重 */
export const builtinCollectionIds = (): readonly string[] => [INNER_ASSET_COLLECTION_ID, AWESOME_ASSET_COLLECTION_ID]
