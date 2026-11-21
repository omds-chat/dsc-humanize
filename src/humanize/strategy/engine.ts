import { DIMENSION_ORDER } from '../types.js'
import type {
  HumanizeStrategy,
  InjectionDimension,
  IntentLabel,
  ResolvedStrategy,
  StrategyResolution,
  StrategyRule,
  StrategyTable,
} from '../types.js'
import { detectLanguage, type LanguageTag } from '../intent/lang.js'

/** 数值字段的取值范围,越界按边界收敛 */
const TEMPERATURE_MIN = 0
const TEMPERATURE_MAX = 2
const TOP_P_MIN = 0
const TOP_P_MAX = 1
const MAX_TOKENS_MIN = 1
const MAX_TOKENS_MAX = 32768

/** 跨维度拼接注入用的分隔符,与注入构建的缺省分隔符一致 */
export const DIMENSION_SEPARATOR = '\n\n'

const DIMENSION_SET: ReadonlySet<string> = new Set(DIMENSION_ORDER)

/** 解析策略时额外施加的判定参数 */
export interface ResolveOptions {
  /** 与规则自身的 minConfidence 取较大值 */
  minConfidence?: number
  /**
   * 分类器给出的语言判定分量(规范 3.3)。
   * 给出时,语言维规则的注入只在规则文案的语言判定与之一致时生效;
   * 该门只作用于 injection,规则其余字段照常合并。
   */
  lang?: LanguageTag
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value

/** 归一化停止词:去空白、去空串、去重,保持首次出现的顺序 */
export const normalizeStop = (stop: readonly string[]): string[] => {
  const seen = new Set<string>()
  const result: string[] = []

  for (const item of stop) {
    const token = item.trim()
    if (token === '' || seen.has(token)) continue
    seen.add(token)
    result.push(token)
  }

  return result
}

/** 校验单条策略;只报问题,不做修正 */
const validateStrategy = (strategy: HumanizeStrategy, at: string): string[] => {
  const problems: string[] = []

  if (strategy.temperature !== undefined
    && !(isFiniteNumber(strategy.temperature)
      && strategy.temperature >= TEMPERATURE_MIN
      && strategy.temperature <= TEMPERATURE_MAX)) {
    problems.push(at + '.temperature 须为 0 到 2 的有限数')
  }

  if (strategy.topP !== undefined
    && !(isFiniteNumber(strategy.topP) && strategy.topP >= TOP_P_MIN && strategy.topP <= TOP_P_MAX)) {
    problems.push(at + '.topP 须为 0 到 1 的有限数')
  }

  if (strategy.maxTokens !== undefined
    && !(isFiniteNumber(strategy.maxTokens)
      && Number.isInteger(strategy.maxTokens)
      && strategy.maxTokens >= MAX_TOKENS_MIN
      && strategy.maxTokens <= MAX_TOKENS_MAX)) {
    problems.push(at + '.maxTokens 须为 1 到 32768 的整数')
  }

  if (strategy.stop !== undefined
    && !(Array.isArray(strategy.stop) && strategy.stop.every((item) => typeof item === 'string'))) {
    problems.push(at + '.stop 必须是字符串数组')
  }

  // 空白项在解析时被规范化丢弃,这里只拒绝非字符串与空串
  if (strategy.injection !== undefined
    && !(typeof strategy.injection === 'string' && strategy.injection.trim() !== '')) {
    problems.push(at + '.injection 必须是非空字符串,不注入时省略该字段')
  }

  const hasField = strategy.temperature !== undefined
    || strategy.topP !== undefined
    || strategy.maxTokens !== undefined
    || strategy.stop !== undefined
    || strategy.injection !== undefined
  if (!hasField) {
    problems.push(at + ' 至少要有 temperature、topP、maxTokens、stop、injection 之一')
  }

  return problems
}

/** 校验策略表:资产加载与装配前都可调用,返回空数组表示通过 */
export const validateStrategyTable = (table: StrategyTable): string[] => {
  const problems: string[] = []

  if (table.id.trim() === '') problems.push('strategies.id 不能为空')
  if (table.version.trim() === '') problems.push('strategies.version 不能为空')

  if (table.base !== undefined) {
    for (const problem of validateStrategy(table.base, 'strategies.base')) problems.push(problem)
  }

  // 规则数组允许为空:此时只有兜底策略,与资产包格式规范 7.3 一致
  table.rules.forEach((rule, index) => {
    const at = 'strategies.rules[' + index + ']'

    if (rule.label.trim() === '') problems.push(at + '.label 不能为空')

    if (rule.priority !== undefined && !isFiniteNumber(rule.priority)) {
      problems.push(at + '.priority 须为有限数')
    }

    if (rule.minConfidence !== undefined
      && !(isFiniteNumber(rule.minConfidence) && rule.minConfidence >= 0 && rule.minConfidence <= 1)) {
      problems.push(at + '.minConfidence 须为 0 到 1 的有限数')
    }

    if (rule.dimension !== undefined && !DIMENSION_SET.has(rule.dimension)) {
      problems.push(at + '.dimension 须为 tone、length、structure、language 之一')
    }

    for (const problem of validateStrategy(rule.strategy, at + '.strategy')) problems.push(problem)
  })

  return problems
}

/**
 * 形状维注入加上对比示例文本,再拼语言维(拼接口径由内核定,见设计文档 3.4)。
 *
 * 对比示例是形状侧的样本约束(规范 3.3、7.5),插在 tone、length、structure
 * 三个形状维之后、语言维之前;语言维文本最后拼接。各段之间用固定分隔符,
 * 空段跳过;不传对比示例时结果就是四维按固定顺序的拼接。
 */
export const composeInjection = (
  injections: Record<InjectionDimension, string>,
  contrastText?: string,
): string => {
  const parts = [injections.tone, injections.length, injections.structure]
  if (contrastText !== undefined && contrastText.trim() !== '') parts.push(contrastText.trim())
  parts.push(injections.language)
  return parts.filter((part) => part !== '').join(DIMENSION_SEPARATOR)
}

/**
 * 把分类结果解析成一条策略(1.1.0 维度合成口径,规范 7.3)。
 *
 * 注入的合成:
 * - 规则缺省 dimension 归 tone;兜底策略的 injection 也归 tone,先于所有规则合并;
 * - 同一维度内按 priority 升序合并,priority 相同按规则在 rules 数组中的出现顺序,
 *   后合并者整体覆盖先合并者;
 * - 跨维度互不覆盖,strategy.injection 按 tone、length、structure、language 固定顺序拼接,
 *   各维明细在 resolutions 的 injections 里;
 * - 语言维受 lang 门约束:给出 lang 时,语言维规则的注入只在规则文案的语言判定
 *   与输入语言判定一致时生效;门只作用于 injection,其余字段照常合并。
 *
 * 其余字段(temperature、topP、maxTokens、stop)不参与维度划分,沿用
 * 「省略不改,给出即覆盖」的单一合并链。数值越界按边界收敛,不做静默丢弃。
 */
export const resolveStrategy = (
  table: StrategyTable,
  labels: readonly IntentLabel[],
  options: ResolveOptions = {},
): StrategyResolution => {
  const floor = options.minConfidence ?? 0
  const byLabel = new Map<string, number>()

  for (const item of labels) {
    const current = byLabel.get(item.label)
    if (current === undefined || item.confidence > current) byLabel.set(item.label, item.confidence)
  }

  const active: { rule: StrategyRule; order: number }[] = []
  table.rules.forEach((rule, index) => {
    const confidence = byLabel.get(rule.label)
    if (confidence === undefined) return
    if (confidence < (rule.minConfidence ?? 0) || confidence < floor) return
    active.push({ rule, order: index })
  })

  active.sort((left, right) => {
    const byPriority = (left.rule.priority ?? 0) - (right.rule.priority ?? 0)
    return byPriority !== 0 ? byPriority : left.order - right.order
  })

  const merged: ResolvedStrategy = {
    temperature: null,
    topP: null,
    maxTokens: null,
    stop: [],
    injection: '',
  }
  const injections: Record<InjectionDimension, string> = { tone: '', length: '', structure: '', language: '' }

  const apply = (source: HumanizeStrategy, dimension: InjectionDimension, injectAllowed: boolean): void => {
    if (isFiniteNumber(source.temperature)) merged.temperature = clamp(source.temperature, TEMPERATURE_MIN, TEMPERATURE_MAX)
    if (isFiniteNumber(source.topP)) merged.topP = clamp(source.topP, TOP_P_MIN, TOP_P_MAX)
    if (isFiniteNumber(source.maxTokens)) merged.maxTokens = Math.round(clamp(source.maxTokens, MAX_TOKENS_MIN, MAX_TOKENS_MAX))
    if (Array.isArray(source.stop)) merged.stop = normalizeStop(source.stop)
    if (injectAllowed && typeof source.injection === 'string' && source.injection.trim() !== '') {
      injections[dimension] = source.injection.trim()
    }
  }

  // 兜底策略的 injection 归 tone 维,先于所有规则合并,可被 tone 维规则覆盖
  if (table.base !== undefined) apply(table.base, 'tone', true)

  for (const entry of active) {
    const dimension: InjectionDimension = entry.rule.dimension ?? 'tone'
    let injectAllowed = true
    if (dimension === 'language' && options.lang !== undefined) {
      const injection = entry.rule.strategy.injection
      if (typeof injection === 'string' && injection.trim() !== '') {
        injectAllowed = detectLanguage(injection) === options.lang
      }
    }
    apply(entry.rule.strategy, dimension, injectAllowed)
  }

  merged.injection = composeInjection(injections)

  return {
    strategy: merged,
    matched: active.map((entry) => entry.rule.label),
    tableVersion: table.version,
    injections,
  }
}
