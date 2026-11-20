import { buildInjection } from './injection/builder.js'
import { resolveStrategy } from './strategy/engine.js'
import type {
  HumanizeKernel,
  HumanizeKernelOptions,
  HumanizePlan,
  InjectionPosition,
} from './types.js'

/** 内核版本:与插件版本各自演进,内核先稳定再对外承诺 */
export const KERNEL_VERSION = '0.1.0'

/**
 * 装配内核:分类器加资产提供的标签集与策略表。
 *
 * plan 只做纯计算,产出意图、策略与注入片段,不接触任何宿主状态。
 * 真正改请求参数与系统提示词需要宿主提供请求拦截能力,本内核不做假设。
 */
export const createHumanizeKernel = (options: HumanizeKernelOptions): HumanizeKernel => {
  const personaPrefix = options.persona?.prefix ?? ''
  const position: InjectionPosition | undefined = options.position

  return {
    classifierId: options.classifier.id,
    plan: async (text: string, existingPrompt = ''): Promise<HumanizePlan> => {
      const intent = await options.classifier.classify({ text, labels: options.labels })
      const strategy = resolveStrategy(options.strategyTable, intent.labels)
      const injection = buildInjection({
        personaPrefix,
        injection: strategy.strategy.injection,
        existingPrompt,
        ...(position === undefined ? {} : { position }),
      })

      return { intent, strategy, injection }
    },
  }
}
