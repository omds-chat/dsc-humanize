import type {
  ClassifyInput,
  IntentClassifier,
  IntentLabel,
  IntentResult,
  LabelDefinition,
} from '../types.js'
import { detectLanguage } from './lang.js'

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

/** 编译锚定短语模式;资产加载层已校验可编译,这里兜底跳过无法编译的项 */
const compilePattern = (pattern: string): RegExp | null => {
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

/**
 * 按命中关键词与锚定模式的数量给标签打分(规范 7.2 的完整口径)。
 *
 * 判定顺序:
 * 1. 排除先行:输入包含任一 exclude_keywords 时,该标签直接不参与计分;
 * 2. 再计关键词与模式:keywords 与 patterns 用同一计分口径,
 *    每命中一个关键词计一次,每有一条模式整条匹配计一次。
 *
 * 置信度取 1 - 1 / (1 + 命中数),再乘以标签权重并收敛到 1:
 * 命中 1 个约 0.5,2 个约 0.67,继续增加趋近 1。
 * 未命中任何关键词与模式的标签不返回;结果按置信度降序,同分按标签 id 排序。
 */
export const scoreLabels = (text: string, labels: readonly LabelDefinition[]): IntentLabel[] => {
  const haystack = fold(text)
  const scored: IntentLabel[] = []

  for (const label of labels) {
    const seen = new Set<string>()
    let hits = 0

    const excluded = (label.exclude_keywords ?? []).some((raw) => {
      const term = fold(raw.trim())
      return term !== '' && haystack.includes(term)
    })
    if (excluded) continue

    for (const raw of label.keywords ?? []) {
      const keyword = fold(raw.trim())
      if (keyword === '' || seen.has(keyword)) continue
      seen.add(keyword)
      if (haystack.includes(keyword)) hits += 1
    }

    const seenPatterns = new Set<string>()
    for (const raw of label.patterns ?? []) {
      if (typeof raw !== 'string' || seenPatterns.has(raw)) continue
      seenPatterns.add(raw)
      const compiled = compilePattern(raw)
      if (compiled === null) continue
      // 模式自带 ^...$ 锚定,整条匹配才算命中;小写折叠后的文本也试一次,
      // 让 ASCII 模式与关键词同样不受大小写影响
      if (compiled.test(text) || compiled.test(haystack)) hits += 1
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
 * 同步分类:打分、按阈值过滤、取最高置信度标签,并并行给出语言判定(规范 3.3)。
 *
 * 输出是 (lang, shape) 二元组:labels 是 shape 侧的解析输入,
 * lang 是语言侧的判定结果,两者解耦——lang 不影响标签命中,标签也不隐含语言。
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

  return { text: input.text, labels, primary, lang: detectLanguage(input.text), classifier: id }
}

/**
 * 创建规则分类器:不依赖模型,只按资产提供的关键词、排除词与锚定模式打分。
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
