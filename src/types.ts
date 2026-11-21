/**
 * dsc 插件契约的精简类型声明。
 *
 * 这份声明是契约的本地副本,只覆盖本插件用到的字段与能力对象。
 * 若与 DeepSeek-Chat-Enhanced 源码不一致,以该源码为准。
 * 契约速查：.agents/dsc-plugin-contract.md(组织内只读文件)。
 */

/** 清单中的能力名,取值来自引擎的能力表 */
export type DscCapability =
  | 'sessions:list'
  | 'sessions:read'
  | 'sessions:rename'
  | 'events:session'
  | 'notify'
  | 'settings:locale'
  | 'settings:surface'
  | 'plugins:storage'
  | 'net:fetch'
  | 'assets:read'
  | 'chat:request'

/** 挂载点:会话切换事件与请求前环节 */
export type DscMount = 'session:changed' | 'chat:before-request'

/**
 * 插件清单。
 * id 须匹配 ^[a-z][a-z0-9-]{2,63}$,version 为三段数字,capabilities 不得重复。
 */
export interface PluginManifest {
  id: string
  name: string
  version: string
  /** 兼容的 dsc-core 版本范围,支持 ^ ~ >= <= 与精确版本 */
  engines?: string
  /** 依赖的插件 id,安装时须已存在,激活时须已激活 */
  dependencies?: string[]
  /** 冲突的插件 id,同时安装会被拒绝 */
  conflicts?: string[]
  capabilities: DscCapability[]
  mounts?: DscMount[]
}

/** 异步能力的通用选项,取消时抛 PluginAbortError */
export interface PluginCallOptions {
  signal?: AbortSignal
}

/**
 * 引擎在能力调用与生命周期里抛出的错误名。
 * 插件按 error.name 判定,不要依赖 instanceof,也不要自行构造。
 */
export type PluginErrorName =
  | 'PluginCapabilityError'
  | 'PluginRateLimitError'
  | 'PluginTimeoutError'
  | 'PluginAbortError'
  | 'PluginDataError'
  | 'PluginFetchError'

/** 会话摘要的可见字段 */
export interface SessionSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

/** 消息附件的可见字段 */
export interface SessionAttachment {
  name: string
  size: number
  isImage: boolean
}

/** 消息的可见字段;不含附件本地 id、服务端 file_id 与原件 */
export interface SessionMessage {
  id: string
  role: 'user' | 'assistant'
  createdAt: number
  text: string
  attachments: SessionAttachment[]
}

/** 会话内容的可见字段,在摘要之上追加消息列表;不含分支结构与请求快照 */
export interface SessionView extends SessionSummary {
  messages: SessionMessage[]
}

/** session:changed 事件的可见字段 */
export interface SessionChangedEvent {
  type: 'session:changed'
  activeId: string | null
}

/** 能力 sessions:list、sessions:read、sessions:rename */
export interface PluginSessionsApi {
  list(options?: PluginCallOptions): Promise<SessionSummary[]>
  read(id: string, options?: PluginCallOptions): Promise<SessionView | null>
  rename(id: string, title: string): boolean
}

/**
 * 能力 events:session。
 * 返回释放函数,引擎在停用与卸载时自动执行,插件不要自行重复调用。
 */
export interface PluginEventsApi {
  on(point: DscMount, handler: (event: SessionChangedEvent) => void): () => void
}

/**
 * 能力 notify。
 * key 取自宿主 i18n 的既有文案键,插件不自造文案。
 */
export interface PluginUiApi {
  notify(key: string, params?: Record<string, string | number>): void
}

/** 设置字段的类型;控件形态由宿主按类型渲染,插件只交描述、不交控件 */
export type PluginSettingFieldType = 'switch' | 'select' | 'number' | 'text' | 'secret'

/** 设置字段的值;只有标量 */
export type PluginSettingValue = string | number | boolean

/** 单个设置字段的描述;字段形态与宿主 dsc-plugin-engine 的 SettingFieldDescriptor 对齐 */
export interface PluginSettingFieldDescriptor {
  /** 字段键;在同一份描述内不得重复,也是设置存储的键 */
  readonly key: string
  readonly type: PluginSettingFieldType
  /** 字段标签;走宿主 i18n 字典,与 label 二选一 */
  readonly labelKey?: string
  /** 字段标签;插件直给的文案 */
  readonly label?: string
  /** 默认值;secret 字段不得有默认值 */
  readonly default?: PluginSettingValue
  /** number 的取值范围 */
  readonly min?: number
  readonly max?: number
  /** number 的步进;只影响宿主控件的交互,不参与校验 */
  readonly step?: number
  /** text 的长度上限 */
  readonly maxLength?: number
  /** text 的形态约束;必须是能通过 new RegExp 编译的正则来源 */
  readonly pattern?: string
}

/** 一份设置表面描述;fields 至少一项,同一插件只保留最后登记的一份 */
export interface PluginSettingDescriptor {
  readonly fields: readonly PluginSettingFieldDescriptor[]
}

/**
 * 能力 settings:locale 与 settings:surface。
 * register 在激活期登记一份字段描述,宿主据此渲染设置表单,返回释放函数,
 * 停用随引擎清理;描述非法时抛 PluginSettingsError。
 * values 只读自身命名空间:用户覆盖值优先,否则默认值,secret 字段不返回;
 * 写侧不在插件上下文,改动只由用户在宿主设置页保存。
 */
export interface PluginSettingsApi {
  locale(options?: PluginCallOptions): Promise<'zh-CN' | 'en-US'>
  register(descriptor: PluginSettingDescriptor): () => void
  values(): Record<string, PluginSettingValue>
}

/**
 * 资产读取的三态结果,与宿主 dsc-core 的 AssetTextResult 同形。
 * content 表示拿到了内容;status 表示拿到了明确的 HTTP 状态码;
 * no-status 表示只有网络层失败、没有任何状态码。
 * 后两态的区别有意保留:拿到状态码说明对方已放行跨域,没有状态码时既可能是地址无效,
 * 也可能是对方未放行跨域,引擎不替插件猜测是哪一种。
 */
export type PluginAssetTextResult =
  | { kind: 'content'; url: string; contentType: string; text: string }
  | { kind: 'status'; url: string; status: number }
  | { kind: 'no-status'; url: string }

/**
 * 能力 assets:read。对全部插件开放,按地址取远端资产包的文本;
 * 只允许 GET、只允许 https 与回环 http,不带凭证,响应体上限 512KB,超时 10 秒。
 * 三态结果原样交给插件;引擎侧能确定的拒绝(地址、协议、体积、超时)抛 PluginAssetError。
 */
export interface PluginAssetsApi {
  readText(url: string, options?: PluginCallOptions): Promise<PluginAssetTextResult>
}

/**
 * 能力 plugins:storage。
 * 值须可 JSON 序列化,单插件上限 64KB,键名非空且不超过 64 字符,缺失的键返回 null。
 */
export interface PluginStorageApi {
  get(key: string): unknown
  set(key: string, value: unknown): void
  remove(key: string): void
}

/** 外源文本请求的返回,只有最终地址、内容类型与文本 */
export interface PluginNetResponse {
  url: string
  contentType: string
  text: string
}

/** 计数请求的返回,响应体被丢弃,只回传最终地址与状态码 */
export interface PluginNetPostResponse {
  url: string
  status: number
}

/**
 * 能力 net:fetch。只对内置插件开放:第三方插件清单申请它时,
 * 安装结果与申请一个不存在的能力一样,都是 unknown-capability。
 * 请求约束由宿主落实:仅 https、不带凭证、响应体上限 512KB、超时 10 秒。
 */
export interface PluginNetApi {
  getText(url: string, options?: PluginCallOptions): Promise<PluginNetResponse>
  postJson(url: string, body: unknown, options?: PluginCallOptions): Promise<PluginNetPostResponse>
}

/** 请求前的只读切片;只给最后一条用户消息文本,不给整段会话 */
export interface ChatRequestPreview {
  readonly lastUserMessage: string
}

/**
 * 请求补丁,插件能返回的全部字段,全部可缺省。
 * 引擎按白名单收敛:未知字段丢弃,越界值按边界裁剪,超时或抛错时整份补丁作废。
 */
export interface ChatRequestPatch {
  /** 0 到 2 */
  temperature?: number
  /** 0 到 1 */
  topP?: number
  /** 1 到 4096 的正整数 */
  maxTokens?: number
  /** 最多 4 条,每条最多 32 字符 */
  stop?: string[]
  /** 追加到系统提示词之后,最多 2000 字符 */
  systemPromptAppend?: string
  /** 整体替换系统提示词,最多 8000 字符 */
  systemPromptReplace?: string
}

/** 请求前处理器;返回补丁、null 或什么都不返回,三者都表示不改请求 */
export type ChatBeforeRequestHandler = (
  preview: ChatRequestPreview,
) => ChatRequestPatch | null | undefined

/**
 * 能力 chat:request。
 * 处理器在每次发请求前同步调用一次,全部处理器共用 10 毫秒预算;
 * 返回释放函数,引擎在停用与卸载时自动执行,插件不要自行重复调用。
 */
export interface PluginChatApi {
  onBeforeRequest(handler: ChatBeforeRequestHandler): () => void
}

/**
 * 激活时注入的上下文。
 * 各能力成员只在清单申请了对应能力时可用,未申请时调用抛 PluginCapabilityError。
 */
export interface PluginContext {
  /** 当前插件 id,与清单一致 */
  readonly id: string
  /** 当前插件版本,与清单一致 */
  readonly version: string
  /** 写入该插件的日志,可在插件面板的「查看日志」中读取 */
  log(message: string): void
  sessions: PluginSessionsApi
  events: PluginEventsApi
  ui: PluginUiApi
  settings: PluginSettingsApi
  assets: PluginAssetsApi
  net: PluginNetApi
  storage: PluginStorageApi
  chat: PluginChatApi
}

/**
 * 插件对象。
 * activate 超时 5 秒,deactivate 超时 3 秒,返回值均被忽略。
 */
export interface DscPlugin {
  activate(context: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}
