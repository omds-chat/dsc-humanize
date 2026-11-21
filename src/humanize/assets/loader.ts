import { validateStrategyTable } from '../strategy/engine.js'
import { CONTENT_TYPES } from '../types.js'
import type {
  AssetCallOptions,
  AssetContents,
  AssetLoadError,
  AssetLoadErrorCode,
  AssetLoadResult,
  AssetPackage,
  AssetRef,
  AssetSource,
  AssetSourceRef,
  AssetTextTransport,
  ContentType,
  HumanizeStrategy,
  InjectionFragment,
  LabelDefinition,
  PersonaProfile,
  StrategyRule,
  StrategyTable,
} from '../types.js'

/** 资产加载器的装配参数 */
export interface AssetLoaderOptions {
  /** URL 读取通道;缺省时 URL 资产一律失败,只支持本地数据 */
  transport?: AssetTextTransport
}

type JsonObject = Record<string, unknown>

/** 单类内容的读取结果 */
type ContentReadResult<TItem> =
  | { ok: true; items: readonly TItem[] }
  | { ok: false; error: AssetLoadError }

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isText = (value: unknown): value is string => typeof value === 'string'

const isNonEmptyText = (value: unknown): value is string =>
  isText(value) && value.trim() !== ''

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const CONTENT_TYPE_SET: ReadonlySet<string> = new Set(CONTENT_TYPES)

const isContentType = (value: unknown): value is ContentType =>
  isText(value) && CONTENT_TYPE_SET.has(value)

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** 失败结果:包文档与已装配内容两条读取路径共用同一套错误形状 */
type LoadFailure = { ok: false; error: AssetLoadError }

const failure = (code: AssetLoadErrorCode, message: string, path?: string): LoadFailure =>
  path === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, path } }

const fail = (code: AssetLoadErrorCode, message: string, path?: string): AssetLoadResult =>
  failure(code, message, path)

const failContent = <TItem>(message: string, path: string): ContentReadResult<TItem> => ({
  ok: false,
  error: { code: 'invalid-asset', message, path },
})

/**
 * 读取人物设定。
 * 只校验内核消费的字段:标识、展示名、前缀;同一类型内标识不重复。
 */
const readPersonaItems = (raw: readonly unknown[], at: string): ContentReadResult<PersonaProfile> => {
  const items: PersonaProfile[] = []
  const seen = new Set<string>()

  for (let index = 0; index < raw.length; index += 1) {
    const path = at + '[' + index + ']'
    const item = raw[index]
    if (!isObject(item)) return failContent('人物设定必须是对象', path)

    const id = item.id
    if (!isNonEmptyText(id)) return failContent('人物设定缺少 id', path + '.id')
    if (seen.has(id)) return failContent('人物设定 id 重复: ' + id, path + '.id')
    seen.add(id)

    const name = item.name
    if (!isNonEmptyText(name)) return failContent('人物设定的 name 不能为空', path + '.name')

    const prefix = item.prefix
    if (!isNonEmptyText(prefix)) return failContent('人物设定的 prefix 不能为空', path + '.prefix')

    const description = item.description
    if (description !== undefined && !isText(description)) {
      return failContent('人物设定的 description 必须是字符串', path + '.description')
    }

    items.push({
      id,
      name,
      prefix,
      ...(description === undefined ? {} : { description }),
    })
  }

  return { ok: true, items }
}

/**
 * 读取分类标签集。
 * 标签集是标签的集合,关键词与权重保持资产给出的值,缺省语义留给分类器。
 */
const readLabelItems = (raw: readonly unknown[], at: string): ContentReadResult<LabelDefinition> => {
  const items: LabelDefinition[] = []
  const seen = new Set<string>()

  for (let index = 0; index < raw.length; index += 1) {
    const path = at + '[' + index + ']'
    const item = raw[index]
    if (!isObject(item)) return failContent('标签必须是对象', path)

    const id = item.id
    if (!isNonEmptyText(id)) return failContent('标签缺少 id', path + '.id')
    if (seen.has(id)) return failContent('标签 id 重复: ' + id, path + '.id')
    seen.add(id)

    const description = item.description
    if (description !== undefined && !isText(description)) {
      return failContent('标签的 description 必须是字符串', path + '.description')
    }

    const keywords = item.keywords
    if (keywords !== undefined) {
      if (!(Array.isArray(keywords) && keywords.every(isText))) {
        return failContent('标签的 keywords 必须是字符串数组', path + '.keywords')
      }
    }

    const weight = item.weight
    if (weight !== undefined) {
      if (!(isFiniteNumber(weight) && weight > 0)) {
        return failContent('标签的 weight 必须是大于 0 的有限数', path + '.weight')
      }
    }

    items.push({
      id,
      ...(description === undefined ? {} : { description }),
      ...(keywords === undefined ? {} : { keywords }),
      ...(weight === undefined ? {} : { weight }),
    })
  }

  return { ok: true, items }
}

/**
 * 读取策略规则。
 *
 * labelIds 是包内标签集的标识集合;为 null 表示包里没有声明标签集,
 * 此时规则的标签引用留待装配阶段由标签集来源解析,本层不判定。
 */
const readStrategyItems = (
  raw: readonly unknown[],
  at: string,
  labelIds: ReadonlySet<string> | null,
): ContentReadResult<StrategyTable> => {
  const items: StrategyTable[] = []
  const seen = new Set<string>()

  for (let index = 0; index < raw.length; index += 1) {
    const path = at + '[' + index + ']'
    const item = raw[index]
    if (!isObject(item)) return failContent('策略规则必须是对象', path)

    const id = item.id
    if (!isNonEmptyText(id)) return failContent('策略规则缺少 id', path + '.id')
    if (seen.has(id)) return failContent('策略规则 id 重复: ' + id, path + '.id')
    seen.add(id)

    const version = item.version
    if (!isNonEmptyText(version)) return failContent('策略规则的 version 不能为空', path + '.version')

    const base = item.base
    if (base !== undefined && !isObject(base)) {
      return failContent('策略表的 base 必须是对象', path + '.base')
    }

    const rules = item.rules
    if (!Array.isArray(rules)) return failContent('策略表的 rules 必须是数组', path + '.rules')

    for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
      const rulePath = path + '.rules[' + ruleIndex + ']'
      const rule = rules[ruleIndex]
      if (!isObject(rule)) return failContent('规则必须是对象', rulePath)

      const label = rule.label
      if (!isNonEmptyText(label)) return failContent('规则缺少 label', rulePath + '.label')
      if (labelIds !== null && !labelIds.has(label)) {
        return failContent('规则引用了包内未定义的标签: ' + label, rulePath + '.label')
      }
      if (!isObject(rule.strategy)) return failContent('规则缺少 strategy', rulePath + '.strategy')
    }

    // 结构已逐项校验,这里收敛成内核类型;取值范围交给 validateStrategyTable
    const table = {
      id,
      version,
      ...(base === undefined ? {} : { base: base as unknown as HumanizeStrategy }),
      rules: rules as readonly StrategyRule[],
    }

    const problems = validateStrategyTable(table)
    if (problems.length > 0) {
      return failContent(problems[0] ?? '策略表不合法', path)
    }

    items.push(table)
  }

  return { ok: true, items }
}

/** 读取注入文本:片段是纯文本,不含变量与占位符 */
const readInjectionItems = (
  raw: readonly unknown[],
  at: string,
): ContentReadResult<InjectionFragment> => {
  const items: InjectionFragment[] = []
  const seen = new Set<string>()

  for (let index = 0; index < raw.length; index += 1) {
    const path = at + '[' + index + ']'
    const item = raw[index]
    if (!isObject(item)) return failContent('注入文本必须是对象', path)

    const id = item.id
    if (!isNonEmptyText(id)) return failContent('注入文本缺少 id', path + '.id')
    if (seen.has(id)) return failContent('注入文本 id 重复: ' + id, path + '.id')
    seen.add(id)

    const name = item.name
    if (!isNonEmptyText(name)) return failContent('注入文本的 name 不能为空', path + '.name')

    const text = item.text
    if (!isNonEmptyText(text)) return failContent('注入文本的 text 不能为空', path + '.text')

    const description = item.description
    if (description !== undefined && !isText(description)) {
      return failContent('注入文本的 description 必须是字符串', path + '.description')
    }

    items.push({
      id,
      name,
      text,
      ...(description === undefined ? {} : { description }),
    })
  }

  return { ok: true, items }
}

/**
 * 读取一份加载期的包文档,按元数据声明的类型返回内容。
 *
 * 判定顺序:元数据字段、类型声明、声明与内容的双向一致、每类条目的字段与标识唯一、
 * 包内策略规则的标签引用。声明了某类却给不出该类条目、有内容却没声明,都整包拒绝;
 * 声明只覆盖内核消费的字段,名称、说明、署名、许可证等展示字段不进入读取结果,
 * 字段是否封闭由资产包格式的校验脚本负责。
 */
export const readAssetPackage = (value: unknown): AssetLoadResult => {
  if (!isObject(value)) return fail('invalid-asset', '包文档必须是对象')

  const metadata = value.metadata
  if (!isObject(metadata)) return fail('invalid-asset', 'metadata 必须是对象', 'metadata')

  const formatVersion = metadata.formatVersion
  if (!isNonEmptyText(formatVersion)) {
    return fail('invalid-asset', 'formatVersion 必须是非空字符串', 'metadata.formatVersion')
  }

  const id = metadata.id
  if (!isNonEmptyText(id)) return fail('invalid-asset', 'id 必须是非空字符串', 'metadata.id')

  const version = metadata.version
  if (!isNonEmptyText(version)) {
    return fail('invalid-asset', 'version 必须是非空字符串', 'metadata.version')
  }

  const declared = metadata.types
  if (!Array.isArray(declared) || declared.length === 0) {
    return fail('invalid-asset', 'types 必须是非空数组', 'metadata.types')
  }

  const types: ContentType[] = []
  for (let index = 0; index < declared.length; index += 1) {
    const at = 'metadata.types[' + index + ']'
    const type = declared[index]
    if (!isContentType(type)) {
      return fail('invalid-asset', '类型声明必须是 persona、labels、strategies、injection 之一', at)
    }
    if (types.includes(type)) return fail('invalid-asset', '类型声明重复: ' + type, at)
    types.push(type)
  }

  const raw = value.contents
  if (!isObject(raw)) return fail('invalid-asset', 'contents 必须是对象', 'contents')

  for (const key of Object.keys(raw)) {
    if (!isContentType(key)) {
      return fail('invalid-asset', 'contents 出现四类之外的类型: ' + key, 'contents.' + key)
    }
    if (!types.includes(key)) {
      return fail('invalid-asset', '包内出现未声明的类型: ' + key, 'contents.' + key)
    }
  }

  const contents: AssetContents = {}
  const source = { id, version }
  // 标签集先于策略规则读取,包内策略的标签引用才能对着本包的标签集判定
  let labelIds: ReadonlySet<string> | null = null

  for (const type of CONTENT_TYPES) {
    if (!types.includes(type)) continue

    const at = 'contents.' + type
    const entries = raw[type]
    if (entries === undefined) {
      return fail('invalid-asset', '声明了 ' + type + ',但包里没有该类内容', at)
    }
    if (!Array.isArray(entries)) {
      return fail('invalid-asset', type + ' 的内容必须是数组', at)
    }
    if (entries.length === 0) {
      return fail('invalid-asset', '声明了 ' + type + ',但该类内容为空', at)
    }

    if (type === 'persona') {
      const result = readPersonaItems(entries, at)
      if (!result.ok) return { ok: false, error: result.error }
      contents.persona = { source, items: result.items }
      continue
    }

    if (type === 'labels') {
      const result = readLabelItems(entries, at)
      if (!result.ok) return { ok: false, error: result.error }
      labelIds = new Set(result.items.map((item) => item.id))
      contents.labels = { source, items: result.items }
      continue
    }

    if (type === 'strategies') {
      const result = readStrategyItems(entries, at, labelIds)
      if (!result.ok) return { ok: false, error: result.error }
      contents.strategies = { source, items: result.items }
      continue
    }

    const result = readInjectionItems(entries, at)
    if (!result.ok) return { ok: false, error: result.error }
    contents.injection = { source, items: result.items }
  }

  const asset: AssetPackage = {
    formatVersion,
    source: { id, version },
    types,
    contents,
  }

  return { ok: true, asset }
}

/** 已装配内容的读取结果 */
export type AssetContentsReadResult =
  | { ok: true; contents: AssetContents }
  | { ok: false; error: AssetLoadError }

/**
 * 读取一份已装配的内容:按类型给出条目与来源。
 *
 * 当前使用快照与导入路径最终都收敛成这一形状,因此校验复用包文档的逐类读取器:
 * 出现的类型必须在四类之内,每一类都要有来源标识与至少一个条目。
 * 跨类型的标签引用不在这里判定:快照可以由多个来源组合而成,
 * 冲突由用户处理(2.9.1),读取层不替用户仲裁。
 */
export const readAssetContents = (value: unknown): AssetContentsReadResult => {
  if (!isObject(value)) return failure('invalid-asset', '内容必须是对象')

  for (const key of Object.keys(value)) {
    if (!isContentType(key)) {
      return failure('invalid-asset', '出现四类之外的类型: ' + key, 'contents.' + key)
    }
  }

  const contents: AssetContents = {}
  let declared = 0

  for (const type of CONTENT_TYPES) {
    const group = value[type]
    if (group === undefined) continue

    const at = 'contents.' + type
    if (!isObject(group)) {
      return failure('invalid-asset', type + ' 必须按来源与条目的形状给出', at)
    }

    const source = group.source
    if (!isObject(source)) return failure('invalid-asset', type + ' 缺少来源标识', at + '.source')

    const sourceId = source.id
    if (!isNonEmptyText(sourceId)) {
      return failure('invalid-asset', '来源标识的 id 不能为空', at + '.source.id')
    }

    const sourceVersion = source.version
    if (sourceVersion !== undefined && !isNonEmptyText(sourceVersion)) {
      return failure('invalid-asset', '来源标识的 version 若出现则不能为空', at + '.source.version')
    }

    const items = group.items
    if (!Array.isArray(items)) {
      return failure('invalid-asset', type + ' 的 items 必须是数组', at + '.items')
    }
    if (items.length === 0) {
      return failure('invalid-asset', type + ' 的 items 不能为空', at + '.items')
    }

    const claimed: AssetSourceRef =
      sourceVersion === undefined ? { id: sourceId } : { id: sourceId, version: sourceVersion }
    declared += 1

    if (type === 'persona') {
      const result = readPersonaItems(items, at + '.items')
      if (!result.ok) return { ok: false, error: result.error }
      contents.persona = { source: claimed, items: result.items }
      continue
    }

    if (type === 'labels') {
      const result = readLabelItems(items, at + '.items')
      if (!result.ok) return { ok: false, error: result.error }
      contents.labels = { source: claimed, items: result.items }
      continue
    }

    if (type === 'strategies') {
      // 标签引用留待装配阶段由标签集来源解析,与包文档读取的口径一致
      const result = readStrategyItems(items, at + '.items', null)
      if (!result.ok) return { ok: false, error: result.error }
      contents.strategies = { source: claimed, items: result.items }
      continue
    }

    const result = readInjectionItems(items, at + '.items')
    if (!result.ok) return { ok: false, error: result.error }
    contents.injection = { source: claimed, items: result.items }
  }

  if (declared === 0) return failure('invalid-asset', '内容里没有任何一类')
  return { ok: true, contents }
}

/**
 * 创建资产源。
 *
 * 当前只支持两条路径:inline 数据直接校验,URL 交给注入的 transport 读取后按 JSON 解析。
 * 内核不发网络请求;宿主没有提供通道时,URL 资产以 transport-missing 失败,
 * 调用方应当回退到内置的本地资产或纯文本兜底。
 */
export const createAssetLoader = (options: AssetLoaderOptions = {}): AssetSource => ({
  id: 'asset-loader',
  load: async (ref: AssetRef, callOptions?: AssetCallOptions): Promise<AssetLoadResult> => {
    if (ref.kind === 'inline') return readAssetPackage(ref.data)

    const transport = options.transport
    if (transport === undefined) {
      return fail('transport-missing', '未提供 URL 读取通道,当前只支持本地资产: ' + ref.url)
    }

    let text: string
    try {
      text = await transport.readText(ref.url, callOptions)
    } catch (error) {
      return fail('transport-failed', '读取资产失败: ' + describeError(error))
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      return fail('invalid-json', '资产不是合法 JSON: ' + ref.url)
    }

    return readAssetPackage(parsed)
  },
})
