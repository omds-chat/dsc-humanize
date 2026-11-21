import type {
  ClassifyInput,
  IntentClassifier,
  IntentLabel,
  IntentResult,
  LabelDefinition,
} from '../types.js'

/** 默认置信度阈值:低于它的标签不进策略解析 */
export const DEFAULT_MIN_CONFIDENCE = 0.3

/** 规则分类器的装配参数 */
export interface RuleClassifierOptions {
  /** 分类器 id,进入分类结果便于审计,缺省 rule-keyword */
  id?: string
  /** 缺省置信度阈值,缺省 0.3 */
  minConfidence?: number
}

/** 统一小写,让 ASCII 关键词不受大小写影响 */
const fold = (text: string): string => text.toLowerCase()

/**
 * 按命中关键词的数量给标签打分。
 *
 * 置信度取 1 - 1 / (1 + 命中数),再乘以标签权重并收敛到 1:
 * 命中 1 个关键词约 0.5,2 个约 0.67,继续增加趋近 1。
 * 未命中任何关键词的标签不返回;结果按置信度降序,同分按标签 id 排序。
 */
export const scoreLabels = (text: string, labels: readonly LabelDefinition[]): IntentLabel[] => {
  const haystack = fold(text)
  const scored: IntentLabel[] = []

  for (const label of labels) {
    const seen = new Set<string>()
    let hits = 0

    for (const raw of label.keywords ?? []) {
      const keyword = fold(raw.trim())
      if (keyword === '' || seen.has(keyword)) continue
      seen.add(keyword)
      if (haystack.includes(keyword)) hits += 1
    }

    if (hits === 0) continue

    const weight = label.weight ?? 1
    const confidence = Math.min(1, (1 - 1 / (1 + hits)) * weight)
    if (confidence > 0) scored.push({ label: label.id, confidence })
  }

  scored.sort((left, right) => right.confidence - left.confidence || left.label.localeCompare(right.label))
  return scored
}

/**
 * 同步分类:打分、按阈值过滤、取最高置信度标签。
 *
 * 规则分类器的唯一实现,异步的 classify 只是给同一结果套一层 Promise。
 * 宿主在请求前同步回调里需要结果时走这里,不能走异步入口。
 */
export const classifyIntent = (
  input: ClassifyInput,
  id: string,
  defaultMinConfidence: number,
): IntentResult => {
  const minConfidence = input.minConfidence ?? defaultMinConfidence
  const labels = scoreLabels(input.text, input.labels).filter((item) => item.confidence >= minConfidence)
  const primary = labels[0] ?? null

  return { text: input.text, labels, primary, classifier: id }
}

/**
 * 创建规则分类器:不依赖模型,只按资产提供的关键词打分。
 * 这是默认可用路径,接入 ONNX 之前装配方都应回退到它。
 */
export const createRuleClassifier = (options: RuleClassifierOptions = {}): IntentClassifier => {
  const id = options.id ?? 'rule-keyword'
  const defaultMinConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE

  return {
    id,
    kind: 'rule',
    classify: (input: ClassifyInput): Promise<IntentResult> =>
      Promise.resolve(classifyIntent(input, id, defaultMinConfidence)),
  }
}

/** 默认实例:装配方只读声明标签集即可使用 */
export const ruleClassifier: IntentClassifier = createRuleClassifier()
