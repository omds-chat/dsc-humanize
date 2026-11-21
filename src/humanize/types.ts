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
  /** 策略表标识,同一来源内唯一;进入来源记录,便于回答用的是哪一份 */
  id: string
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
  /** 注入文本类资产给出的片段,按数组顺序接在策略注入文本之后 */
  fragments?: readonly string[]
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

/* ---------- 资产:内容与来源 ---------- */

/**
 * 四类内容的标识,顺序与资产包格式规范 3.1 一致。
 * 类型集合固定:每一类对应内核里一处装配点,扩展类型属内核版本变更。
 */
export const CONTENT_TYPES = ['persona', 'labels', 'strategies', 'injection'] as const

/** 内容类型标识:人物设定、分类标签集、策略规则、注入文本 */
export type ContentType = (typeof CONTENT_TYPES)[number]

/** 人物设定,属于人性化资产 */
export interface PersonaProfile {
  id: string
  name: string
  /** 拼在提示词前的固定文本 */
  prefix: string
  /** 语义说明,资产可以不提供 */
  description?: string
}

/** 注入文本,属于人性化资产;装配时并入注入环节 */
export interface InjectionFragment {
  id: string
  name: string
  /** 注入到系统提示词的文本 */
  text: string
  /** 语义说明,资产可以不提供 */
  description?: string
}

/**
 * 来源标识。
 * 资产包用包的标识与版本;用户自写内容由调用方给一个标识,内核不解释标识的含义。
 */
export interface AssetSourceRef {
  id: string
  /** 来源版本;用户自写内容可以不填 */
  version?: string
}

/**
 * 某一类内容的一份来源:来源标识加上该类型的条目。
 * 每类是一个集合,允许为空;来源与条目一起保存,装配结果据此回答「这段内容从哪来」。
 */
export interface AssetContent<TItem> {
  source: AssetSourceRef
  items: readonly TItem[]
}

/**
 * 按类型划分的资产内容。
 * 出现键表示这一类有来源,缺键表示这一类没有内容;四类可以来自不同的来源,由调用方选定。
 */
export interface AssetContents {
  persona?: AssetContent<PersonaProfile>
  labels?: AssetContent<LabelDefinition>
  strategies?: AssetContent<StrategyTable>
  injection?: AssetContent<InjectionFragment>
}

/**
 * 加载后的资产包:元数据收敛为来源标识与版本,内容按类型分组。
 * 只含包声明的类型;声明与内容的一致性由加载层保证。
 */
export interface AssetPackage {
  /** 包的格式版本,原样保留 */
  formatVersion: string
  /** 包标识与包版本,即包内各类型条目的来源 */
  source: AssetSourceRef
  /** 包声明的类型,保持元数据里的顺序 */
  types: readonly ContentType[]
  contents: AssetContents
}

/**
 * 加载期的包文档。
 *
 * 资产包在磁盘上是一个目录:asset.json 加若干已声明的类型目录,一个文件一项内容。
 * 内核只接受一次读取能拿到的文本,因此由调用方把目录扁平化成一份文档:
 * asset.json 原样放进 metadata,类型目录下的条目按类型分组成数组放进 contents。
 * 目录形态是格式的权威形态,这份文档只解决「一次读取拿到整包」的问题。
 */
export interface AssetPackageDocument {
  /** 资产包的 asset.json 内容 */
  metadata: unknown
  /** 类型标识到该类型条目数组的映射;缺键表示包里没有这一类 */
  contents?: unknown
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
  | { ok: true; asset: AssetPackage }
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
  /**
   * 按类型选定的资产内容:每一类给出一个来源与其中的条目。
   * 来源由调用方选定,内核不设跨包优先级;缺键表示这一类没有内容。
   */
  contents: AssetContents
  position?: InjectionPosition
}

/** 装配结果里一类内容的来源记录 */
export interface AssetAttribution {
  type: ContentType
  source: AssetSourceRef
  /** 实际参与装配的条目标识 */
  itemIds: readonly string[]
}

/** 一次规划的产物:意图、策略、注入片段与来源记录,尚未落到任何请求上 */
export interface HumanizePlan {
  intent: IntentResult
  strategy: StrategyResolution
  injection: InjectionResult
  /** 每一类参与装配的内容来自哪里,按 persona、labels、strategies、injection 排序 */
  attribution: readonly AssetAttribution[]
}

/** 内核 */
export interface HumanizeKernel {
  readonly classifierId: string
  /** 纯计算:不读写宿主状态,不执行请求 */
  plan(text: string, existingPrompt?: string): Promise<HumanizePlan>
}
