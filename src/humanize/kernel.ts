import { buildInjection } from './injection/builder.js'
import { resolveStrategy } from './strategy/engine.js'
import type {
  AssetAttribution,
  AssetContent,
  AssetContents,
  ContentType,
  HumanizeKernel,
  HumanizeKernelOptions,
  HumanizePlan,
  InjectionPosition,
  StrategyTable,
} from './types.js'

/** 内核版本:与插件版本各自演进,内核先稳定再对外承诺 */
export const KERNEL_VERSION = '0.1.0'

/** 没有策略表时的占位:解析结果各字段为空,规划等于「不改变请求」 */
const EMPTY_STRATEGY_TABLE: StrategyTable = { id: '', version: '', rules: [] }

/**
 * 取单条目类型的内容。
 * 人设与策略表在一次装配里各只用一份,多条目属于组合阶段的取舍,内核不替调用方挑。
 */
const pickSingle = <TItem extends { id: string }>(
  type: ContentType,
  content: AssetContent<TItem> | undefined,
): TItem | undefined => {
  if (content === undefined) return undefined
  if (content.items.length > 1) {
    throw new Error('humanize: ' + type + ' 只能有一个条目,多条目须在组合阶段选定一个')
  }
  return content.items[0]
}

/** 记录一类内容的来源;空集合不参与装配,不进入来源记录 */
const describeAttribution = (
  type: ContentType,
  content: AssetContent<{ id: string }> | undefined,
): AssetAttribution | null => {
  if (content === undefined || content.items.length === 0) return null
  return {
    type,
    source: content.source,
    itemIds: content.items.map((item) => item.id),
  }
}

/** 按固定顺序给出每一类内容的来源记录,每次规划重新生成,调用方改不到彼此 */
const describeContents = (contents: AssetContents): readonly AssetAttribution[] => [
  describeAttribution('persona', contents.persona),
  describeAttribution('labels', contents.labels),
  describeAttribution('strategies', contents.strategies),
  describeAttribution('injection', contents.injection),
].filter((entry): entry is AssetAttribution => entry !== null)

/**
 * 装配内核:分类器加按类型选定的资产内容。
 *
 * 每一类内容各取一个来源,来源由调用方选定,内核不设跨包优先级,也不读包;
 * plan 只做纯计算,产出意图、策略、注入片段与来源记录,不接触任何宿主状态。
 * 真正改请求参数与系统提示词需要宿主提供请求拦截能力,本内核不做假设。
 */
export const createHumanizeKernel = (options: HumanizeKernelOptions): HumanizeKernel => {
  const contents = options.contents
  const persona = pickSingle('persona', contents.persona)
  const strategyTable = pickSingle('strategies', contents.strategies)
  const labels = contents.labels?.items ?? []
  const fragments = (contents.injection?.items ?? []).map((item) => item.text)
  const position: InjectionPosition | undefined = options.position

  return {
    classifierId: options.classifier.id,
    plan: async (text: string, existingPrompt = ''): Promise<HumanizePlan> => {
      const intent = await options.classifier.classify({ text, labels })
      const strategy = resolveStrategy(strategyTable ?? EMPTY_STRATEGY_TABLE, intent.labels)
      const injection = buildInjection({
        ...(persona === undefined ? {} : { personaPrefix: persona.prefix }),
        injection: strategy.strategy.injection,
        fragments,
        existingPrompt,
        ...(position === undefined ? {} : { position }),
      })

      return { intent, strategy, injection, attribution: describeContents(contents) }
    },
  }
}
