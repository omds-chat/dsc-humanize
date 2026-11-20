import { validateStrategyTable } from '../strategy/engine.js'
import type {
  AssetBundle,
  AssetCallOptions,
  AssetLoadErrorCode,
  AssetLoadResult,
  AssetRef,
  AssetSource,
  AssetTextTransport,
  StrategyTable,
} from '../types.js'

/** 资产加载器的装配参数 */
export interface AssetLoaderOptions {
  /** URL 读取通道;缺省时 URL 资产一律失败,只支持本地数据 */
  transport?: AssetTextTransport
}

type JsonObject = Record<string, unknown>

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isText = (value: unknown): value is string => typeof value === 'string'

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const fail = (code: AssetLoadErrorCode, message: string, path?: string): AssetLoadResult => ({
  ok: false,
  error: path === undefined ? { code, message } : { code, message, path },
})

/**
 * 校验资产包结构并收敛成 AssetBundle。
 * 只认本内核需要的字段,资产格式尚未定版,多出的字段一律忽略。
 */
export const readAssetBundle = (value: unknown): AssetLoadResult => {
  if (!isObject(value)) return fail('invalid-asset', '资产包必须是对象')

  const schemaVersion = value.schemaVersion
  if (!isText(schemaVersion) || schemaVersion.trim() === '') {
    return fail('invalid-asset', 'schemaVersion 必须是非空字符串', 'schemaVersion')
  }

  const labels = value.labels
  if (!Array.isArray(labels) || labels.length === 0) {
    return fail('invalid-asset', 'labels 必须是非空数组', 'labels')
  }

  const labelIds = new Set<string>()
  for (let index = 0; index < labels.length; index += 1) {
    const at = 'labels[' + index + ']'
    const label: unknown = labels[index]
    if (!isObject(label)) return fail('invalid-asset', '标签必须是对象', at)

    if (!isText(label.id) || label.id.trim() === '') {
      return fail('invalid-asset', '标签缺少 id', at + '.id')
    }
    if (labelIds.has(label.id)) return fail('invalid-asset', '标签 id 重复: ' + label.id, at + '.id')
    labelIds.add(label.id)

    if (label.description !== undefined && !isText(label.description)) {
      return fail('invalid-asset', '标签的 description 必须是字符串', at + '.description')
    }
    if (label.keywords !== undefined && !(Array.isArray(label.keywords) && label.keywords.every(isText))) {
      return fail('invalid-asset', '标签的 keywords 必须是字符串数组', at + '.keywords')
    }
    if (label.weight !== undefined && !(isFiniteNumber(label.weight) && label.weight > 0)) {
      return fail('invalid-asset', '标签的 weight 必须是大于 0 的有限数', at + '.weight')
    }
  }

  const strategies = value.strategies
  if (!isObject(strategies)) return fail('invalid-asset', 'strategies 必须是对象', 'strategies')
  if (!isText(strategies.version) || strategies.version.trim() === '') {
    return fail('invalid-asset', 'strategies.version 必须是非空字符串', 'strategies.version')
  }
  if (!Array.isArray(strategies.rules)) {
    return fail('invalid-asset', 'strategies.rules 必须是数组', 'strategies.rules')
  }

  for (let index = 0; index < strategies.rules.length; index += 1) {
    const at = 'strategies.rules[' + index + ']'
    const rule: unknown = strategies.rules[index]
    if (!isObject(rule)) return fail('invalid-asset', '规则必须是对象', at)
    if (!isText(rule.label) || rule.label.trim() === '') {
      return fail('invalid-asset', '规则缺少 label', at + '.label')
    }
    if (!labelIds.has(rule.label)) {
      return fail('invalid-asset', '规则引用了未定义的标签: ' + rule.label, at + '.label')
    }
    if (!isObject(rule.strategy)) return fail('invalid-asset', '规则缺少 strategy', at + '.strategy')
  }

  // 结构已逐项校验,这里收敛成内核类型;取值范围交给 validateStrategyTable
  const table = strategies as unknown as StrategyTable
  const problems = validateStrategyTable(table)
  if (problems.length > 0) {
    return fail('invalid-asset', problems[0] ?? '策略表不合法', 'strategies')
  }

  const persona = value.persona
  if (persona !== undefined) {
    if (!isObject(persona)) return fail('invalid-asset', 'persona 必须是对象', 'persona')
    if (!isText(persona.id) || persona.id.trim() === '') {
      return fail('invalid-asset', 'persona.id 必须是非空字符串', 'persona.id')
    }
    if (!isText(persona.name) || persona.name.trim() === '') {
      return fail('invalid-asset', 'persona.name 必须是非空字符串', 'persona.name')
    }
    if (!isText(persona.prefix)) {
      return fail('invalid-asset', 'persona.prefix 必须是字符串', 'persona.prefix')
    }
  }

  const bundle = {
    schemaVersion,
    labels,
    strategies: table,
    ...(persona === undefined ? {} : { persona }),
  } as unknown as AssetBundle

  return { ok: true, bundle }
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
    if (ref.kind === 'inline') return readAssetBundle(ref.data)

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

    return readAssetBundle(parsed)
  },
})
