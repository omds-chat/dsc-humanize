import { buildInjection } from '../humanize/injection/builder.js'
import { classifyIntent, DEFAULT_MIN_CONFIDENCE } from '../humanize/intent/rule-classifier.js'
import { resolveStrategy } from '../humanize/strategy/engine.js'
import type {
  AssetContents,
  ClassifyInput,
  InjectionResult,
  IntentResult,
  ResolvedStrategy,
  StrategyTable,
} from '../humanize/types.js'
import type { ChatBeforeRequestHandler, ChatRequestPatch } from '../types.js'

/** 规则分类器的标识,与 createRuleClassifier 的缺省 id 一致 */
const RULE_CLASSIFIER_ID = 'rule-keyword'

/**
 * 同步分类器。
 *
 * 宿主在请求前同步调用处理器,全部处理器共用 10 毫秒预算;异步分类拿不到结果,
 * 因此这一层只接受同步实现。规则分类器的同步入口由 classifyIntent 提供,
 * 异步的 IntentClassifier 不能直接放在这里。
 */
export interface SyncIntentClassifier {
  readonly id: string
  classify(input: ClassifyInput): IntentResult
}

/** 请求前处理器的装配参数 */
export interface RequestHandlerOptions {
  /**
   * 当前使用快照中按类型的内容。
   * 每次请求重新读取,装配方替换内容后不必重新激活。
   */
  contents: () => AssetContents
  /** 同步分类器,缺省为规则分类器 */
  classifier?: SyncIntentClassifier
  /** 写插件日志,缺省不写 */
  log?: (message: string) => void
}

/** 缺省分类器:与 createRuleClassifier 的缺省实例同一套打分与阈值 */
const ruleKeywordClassifier: SyncIntentClassifier = {
  id: RULE_CLASSIFIER_ID,
  classify: (input) => classifyIntent(input, RULE_CLASSIFIER_ID, DEFAULT_MIN_CONFIDENCE),
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * 把解析后的策略与注入结果映射成宿主补丁。
 *
 * 只给宿主支持的字段;数值与文本不再本地裁剪,越界由引擎按补丁上限收敛。
 * 注入只走 systemPromptAppend:宿主切片里没有系统提示词,整体替换会丢掉宿主自己的内容。
 */
const toPatch = (strategy: ResolvedStrategy, injection: InjectionResult): ChatRequestPatch | null => {
  const patch: ChatRequestPatch = {}

  if (strategy.temperature !== null) patch.temperature = strategy.temperature
  if (strategy.topP !== null) patch.topP = strategy.topP
  if (strategy.maxTokens !== null) patch.maxTokens = strategy.maxTokens
  if (strategy.stop.length > 0) patch.stop = [...strategy.stop]
  if (injection.prompt.trim() !== '') patch.systemPromptAppend = injection.prompt

  return Object.keys(patch).length === 0 ? null : patch
}

/**
 * 创建宿主请求前处理器。
 *
 * 链路:最后一条用户消息 -> 内核分类 -> 策略解析 -> 注入拼接 -> 宿主补丁。
 * 没有标签集或策略表时返回 null,不改请求;分类器抛错或资产不合法时同样返回 null,
 * 只写日志,不阻断请求。同一个原因只记一次,避免每次请求都刷插件日志。
 */
export const createBeforeRequestHandler = (
  options: RequestHandlerOptions,
): ChatBeforeRequestHandler => {
  const classifier = options.classifier ?? ruleKeywordClassifier
  const logged = new Set<string>()
  const logOnce = (message: string): void => {
    if (logged.has(message)) return
    logged.add(message)
    options.log?.(message)
  }

  return (preview) => {
    const contents = options.contents()
    const labels = contents.labels?.items ?? []
    const tables: readonly StrategyTable[] = contents.strategies?.items ?? []

    if (labels.length === 0 || tables.length === 0) {
      logOnce('没有标签集或策略表,不修改请求')
      return null
    }
    if (tables.length > 1) {
      logOnce('策略表只能有一个条目,不修改请求')
      return null
    }

    const table = tables[0]
    if (table === undefined) return null

    const personas = contents.persona?.items ?? []
    if (personas.length > 1) {
      logOnce('人物设定只能有一个条目,不修改请求')
      return null
    }
    const persona = personas[0]
    const fragments = (contents.injection?.items ?? []).map((item) => item.text)

    let strategy: ResolvedStrategy
    let injection: InjectionResult
    try {
      const intent = classifier.classify({ text: preview.lastUserMessage, labels })
      strategy = resolveStrategy(table, intent.labels).strategy
      // 宿主只给最后一条用户消息,拿不到已有系统提示词;以空串为起点,
      // 由宿主把结果追加到现有提示词之后
      injection = buildInjection({
        ...(persona === undefined ? {} : { personaPrefix: persona.prefix }),
        injection: strategy.injection,
        fragments,
        existingPrompt: '',
      })
    } catch (error) {
      logOnce('请求前处理失败(' + classifier.id + '),不修改请求: ' + describeError(error))
      return null
    }

    return toPatch(strategy, injection)
  }
}
