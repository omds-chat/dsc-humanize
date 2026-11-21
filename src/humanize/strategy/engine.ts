import type {
  HumanizeStrategy,
  IntentLabel,
  ResolvedStrategy,
  StrategyResolution,
  StrategyRule,
  StrategyTable,
} from '../types.js'

/** 数值字段的取值范围,越界按边界收敛 */
const TEMPERATURE_MIN = 0
const TEMPERATURE_MAX = 2
const TOP_P_MIN = 0
const TOP_P_MAX = 1
const MAX_TOKENS_MIN = 1
const MAX_TOKENS_MAX = 32768

/** 解析策略时额外施加的置信度下限 */
export interface ResolveOptions {
  /** 与规则自身的 minConfidence 取较大值 */
  minConfidence?: number
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

    for (const problem of validateStrategy(rule.strategy, at + '.strategy')) problems.push(problem)
  })

  return problems
}

/**
 * 把分类结果解析成一条策略。
 *
 * 合并顺序:先 base,再按 priority 升序合并命中的规则,priority 相同按声明顺序;
 * 后合并的值覆盖先前的值,injection 只被非空值覆盖。
 * 数值越界按边界收敛,不做静默丢弃。
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

  const apply = (source: HumanizeStrategy): void => {
    if (isFiniteNumber(source.temperature)) merged.temperature = clamp(source.temperature, TEMPERATURE_MIN, TEMPERATURE_MAX)
    if (isFiniteNumber(source.topP)) merged.topP = clamp(source.topP, TOP_P_MIN, TOP_P_MAX)
    if (isFiniteNumber(source.maxTokens)) merged.maxTokens = Math.round(clamp(source.maxTokens, MAX_TOKENS_MIN, MAX_TOKENS_MAX))
    if (Array.isArray(source.stop)) merged.stop = normalizeStop(source.stop)
    if (typeof source.injection === 'string' && source.injection.trim() !== '') merged.injection = source.injection.trim()
  }

  if (table.base !== undefined) apply(table.base)
  for (const entry of active) apply(entry.rule.strategy)

  return {
    strategy: merged,
    matched: active.map((entry) => entry.rule.label),
    tableVersion: table.version,
  }
}
