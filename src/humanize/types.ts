/**
 * dsc-humanize 内核的公共类型。
 *
 * 内核只描述「文本 -> 标签 -> 策略 -> 注入片段」这条链路,
 * 不执行请求,也不读写宿主状态:请求参数与系统提示词的落点由宿主决定。
 */

/* ---------- 意图分类 ---------- */

/** 意图标签的最小定义,由资产包提供 */
export interface LabelDefinition {
  /** 标签 id,分类器只输出标签集内出现过的 id */
  id: string
  /** 语义说明,供人工核对与模型分类使用 */
  description?: string
  /** 关键词,规则分类器使用;资产可以不提供 */
  keywords?: readonly string[]
  /** 标签权重,折算置信度时使用,缺省为 1 */
  weight?: number
}

/** 单个标签的分类结果 */
export interface IntentLabel {
  label: string
  /** 0 到 1,越大越可信 */
  confidence: number
}

/** 分类器的输出 */
export interface IntentResult {
  /** 原文,便于日志与回放 */
  text: string
  /** 按置信度降序,已过滤达不到阈值的标签 */
  labels: readonly IntentLabel[]
  /** 置信度最高的标签,无可信标签时为 null */
  primary: IntentLabel | null
  /** 产出该结果的分类器 id */
  classifier: string
}

/** 分类器输入 */
export interface ClassifyInput {
  text: string
  /** 资产提供的标签集 */
  labels: readonly LabelDefinition[]
  /** 置信度阈值,低于它的标签被丢弃,缺省 0.3 */
  minConfidence?: number
  /** 取消信号,供模型分类器使用;规则分类器同步完成,可忽略 */
  signal?: AbortSignal
}

/** 分类器种类,装配时据此选择实现 */
export type ClassifierKind = 'rule' | 'onnx'

/**
 * 意图分类器。
 * 实现只做文本到标签的映射,不读写宿主状态,也不改写请求。
 */
export interface IntentClassifier {
  readonly id: string
  readonly kind: ClassifierKind
  classify(input: ClassifyInput): Promise<IntentResult>
}

/* ---------- 策略引擎 ---------- */

/**
 * 请求策略。
 * 字段与模型请求参数同名,内核只产出、不执行,是否落到请求上由宿主决定。
 */
export interface HumanizeStrategy {
  temperature?: number
  topP?: number
  maxTokens?: number
  /** 停止词,生成命中即结束 */
  stop?: readonly string[]
  /** 注入到系统提示词的文本 */
  injection?: string
}

/** 资产提供的一条标签到策略的映射 */
export interface StrategyRule {
  /** 标签 id,须在资产包的标签集内 */
  label: string
  /** 合并顺序,越大越晚合并,缺省 0 */
  priority?: number
  /** 仅当该标签的置信度不低于此值时生效,缺省 0 */
  minConfidence?: number
  strategy: HumanizeStrategy
}

/** 策略表,由资产包提供;内核不内置任何具体策略 */
export interface StrategyTable {
  /** 策略表版本,进入解析结果便于审计 */
  version: string
  /** 兜底策略,先于所有规则合并 */
  base?: HumanizeStrategy
  rules: readonly StrategyRule[]
}

/** 解析后的策略:字段已收敛,null 表示资产未给出 */
export interface ResolvedStrategy {
  temperature: number | null
  topP: number | null
  maxTokens: number | null
  stop: readonly string[]
  injection: string
}

/** 策略解析结果 */
export interface StrategyResolution {
  strategy: ResolvedStrategy
  /** 命中的标签,按合并顺序 */
  matched: readonly string[]
  tableVersion: string
}

/* ---------- 注入构建 ---------- */

/** 注入片段相对已有提示词的位置 */
export type InjectionPosition = 'prepend' | 'append'

/** 注入构建的输入 */
export interface InjectionInput {
  /** 人设前缀,来自资产 */
  personaPrefix?: string
  /** 策略给出的注入文本 */
  injection?: string
  /** 已有的系统提示词,可为空 */
  existingPrompt?: string
  /** 缺省 append */
  position?: InjectionPosition
  /** 片段之间的分隔符,缺省两个换行 */
  separator?: string
}

/** 被丢弃的片段及原因 */
export interface DroppedFragment {
  reason: 'empty' | 'duplicate' | 'already-present'
  text: string
}

/** 注入构建结果 */
export interface InjectionResult {
  /** 拼接后的提示词 */
  prompt: string
  /** 本次真正加入的片段数 */
  added: number
  /** 因空串、重复或已存在而丢弃的片段 */
  dropped: readonly DroppedFragment[]
}

/* ---------- 资产 ---------- */

/** 人物设定,属于人性化资产 */
export interface PersonaProfile {
  id: string
  name: string
  /** 拼在提示词前的固定文本 */
  prefix: string
}

/** 资产包的最小结构;格式待定,当前只约定读取所需字段 */
export interface AssetBundle {
  schemaVersion: string
  labels: readonly LabelDefinition[]
  strategies: StrategyTable
  persona?: PersonaProfile
}

/** 资产引用:URL 或已解析的本地数据 */
export type AssetRef =
  | { kind: 'url'; url: string }
  | { kind: 'inline'; data: unknown }

/** 资产调用的通用选项 */
export interface AssetCallOptions {
  signal?: AbortSignal
}

/**
 * URL 读取通道。
 * 内核自己不发请求:要读 URL 资产,由调用方注入实现,
 * 宿主侧对应的能力是 net:fetch,且只对内置插件开放。
 */
export interface AssetTextTransport {
  readText(url: string, options?: AssetCallOptions): Promise<string>
}

/** 资产读取失败的原因 */
export type AssetLoadErrorCode =
  | 'transport-missing'
  | 'transport-failed'
  | 'invalid-json'
  | 'invalid-asset'

/** 资产读取错误 */
export interface AssetLoadError {
  code: AssetLoadErrorCode
  message: string
  /** 资产内的字段路径,校验失败时给出 */
  path?: string
}

/** 资产读取结果;不抛错,由调用方决定降级方式 */
export type AssetLoadResult =
  | { ok: true; bundle: AssetBundle }
  | { ok: false; error: AssetLoadError }

/** 资产源 */
export interface AssetSource {
  readonly id: string
  load(ref: AssetRef, options?: AssetCallOptions): Promise<AssetLoadResult>
}

/* ---------- 内核装配 ---------- */

/** 内核装配参数 */
export interface HumanizeKernelOptions {
  classifier: IntentClassifier
  /** 资产提供的标签集,分类器只能从中选择 */
  labels: readonly LabelDefinition[]
  strategyTable: StrategyTable
  persona?: PersonaProfile
  position?: InjectionPosition
}

/** 一次规划的产物:意图、策略与注入片段,尚未落到任何请求上 */
export interface HumanizePlan {
  intent: IntentResult
  strategy: StrategyResolution
  injection: InjectionResult
}

/** 内核 */
export interface HumanizeKernel {
  readonly classifierId: string
  /** 纯计算:不读写宿主状态,不执行请求 */
  plan(text: string, existingPrompt?: string): Promise<HumanizePlan>
}
