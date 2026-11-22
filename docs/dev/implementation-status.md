# 实现现状

> 本文记录当前已接入的模块、各自的状态与边界,以及资产市场标签与四处界面槽位的落地行为;只描述现状,不承载定位与机制论证。定位见主 README,机制与取舍见 [docs/design/](../design/) 下的设计文档,工程操作口径见 [engineering-handbook.md](engineering-handbook.md)。模块状态随实现演进,变化当轮更新本文。

## 模块一览

- 从 dsc-plugin-template 复制来的工程骨架:清单、激活、停用
- 一份契约类型的本地副本,脱离 DeepSeek-Chat-Enhanced 源码也有类型提示
- 一套构建流程:打包 `plugin.js`、生成并自校验 `meta.json`、写入 `MUST_PLUSH_WITH_PACKAGE` 标记
- 一条可选的作者签名链路:打开开关后用 openssl 对 `plugin.js` 生成 `.author.sig`
- 文本产物强制 LF 换行,`plugin.js` 默认行压缩
- 一套可校验的规范区:运行时规范、开发规范与 JSON Schema,随仓库保留用于本地校验
- 一套内核骨架:输出 (lang, shape) 二元组的意图分类(标签命中加语言判定,支持排除词与锚定模式)、按维度合成注入的策略解析(同维覆盖、跨维拼接、语言维归 lang)、含对比示例的提示词注入拼接与按五类读取的资产适配层,不依赖模型与宿主能力
- 一套宿主请求前接线:申请 `chat:request` 能力并声明 `chat:before-request` 挂载点,把内核的策略与注入结果映射成宿主补丁
- 一条本地资产交付路径:激活时从 IndexedDB 读取当前使用快照并装配,并把插件存储里的过渡快照一次性迁入,另有 `importAssetPackage` 从 JSON 文本导入资产包文档;快照的库内约定按 [kernel-and-assets.md](../design/kernel-and-assets.md) 4.6 的初版实现,标注为可调整
- 一条根证书内嵌与链校验链路:构建时读取 `certs/dsc-humanize/dsc-humanize-root-ca.crt`,把 PEM 注入为产物常量,运行时导出 `EMBEDDED_ROOT_CA_PEM`;`importAssetPackage` 带来源证书时先用它做「根 → EEC」两级链校验,按两轴结论(签名结论 + 来源结论)降级来源结论、不阻断导入
- 一条资产市场逻辑层(按 [docs/design/asset-market.md](../design/asset-market.md)):清单申请 `assets:read` 与 `settings:surface`;激活时把 `context.assets.readText` 包装成内核 transport 注入(三态透传:content 取件成功、status 按 3.x 口径降级、no-status 与通道拒绝按 transport-failed,未获能力或宿主无 assets 成员时保持 transport-missing,本地资产不受影响);内置两条来源(组织预设与社区合集,base_url 列表见 [asset-market.md](../design/asset-market.md) 2.2,本地联调地址由构建注入、非法时退回线上),来源开关与一条自建来源经设置表面字段存储;目录取件按 [asset-market.md](../design/asset-market.md) 3.1 的目录部分实现(来源元数据 → 合集证书三档 → 内嵌根校链 → assets.json),两种合集元数据形状兼容读取([asset-market.md](../design/asset-market.md) 8.2),结论按 [asset-market.md](../design/asset-market.md) 3.4 两轴记录,链校验复用 `verifySourceTrust`;安装入口 `installMarketPackage` 按包层清单逐文件取件并比对 SHA-512,整包校验复用 `importAssetPackage` 的既有原子语义,安装记录含来源标识、base_url 与版本
- 一块资产市场标签(已按 ui:slot 落地,入口:会话视图标签栏里的资产市场标签;宿主插槽细节以引擎文档为准):清单申请 `ui:slot` 能力,在 `slots` 白名单里声明 `conversation.tabs`,并声明 `ui:slot-action` 与 `ui:slot-data` 挂载点;激活时用 `context.ui.registerSlot` 把「资产市场」条目登记到 `conversation.tabs`(order 50,标题按宿主语言取 zh/en 成对词条的一侧),数据挂载点每次索取模型都按既有 catalog 层补取件并做内存短缓存(5 分钟,「刷新目录」绕过),动作挂载点把「安装」分发到 `installMarketPackage`、把「刷新目录」转成刷新指示;来源不可用时该来源折叠成一行说明,只提示不阻断;详见下文「资产市场」节
- 两处补充落点(同属 ui:slot,清单 `slots` 白名单一并声明):`composer.toolbar` 的「人性化」开关按钮(文案带开 / 关状态,点击经 `ui:slot-action` 翻转「是否启用资产改写」,开关值存独立存储键 `dsc-humanize/rewrite/v1`,切换后按同 id 重新登记刷新按钮,并用一次气泡说明当前状态;关闭时请求前处理器返回 `null`,请求按原样发出)与 `overlay.notice` 的资产状态通知(资产来源不可达或资产包不可用时登记一条说明原因的常驻通知,问题消失即撤销登记,正常时不注册);四处槽位的清单与设置页入口见下文「界面槽位」节
- 一块资产来源设置页(同属 ui:slot,清单 `slots` 白名单一并声明 `settings.page`;入口:设置 → 插件 → 资产来源):激活时用 `context.ui.registerSlot` 把「资产来源」条目登记到 `settings.page`(id `asset-sources`,order 100),页面由 form(与设置表面同一份字段:两个内置来源开关 + 自建来源 URL 与合集 id)、text(保存口径说明)与 actions(「保存来源配置」)三个区块组成;数据挂载点每次索取模型都按当前生效值回填表单字段的默认值,动作挂载点把表单草稿写进插件设置(键 `dsc-humanize/asset-sources/v1`),下一次取件即按新来源解析;详见下文「资产来源设置页」节
- 一份本地回环冒烟脚本:`node --import ./scripts/test/ts-hooks.mjs scripts/smoke-market.mjs` 在 127.0.0.1:61120 与 61121 起两个静态目录(inner 用 indexed 形状与证书第一档,awesome 用 flat 形状与证书第二档),走完整的目录取件、slot 描述生成、动作分发与安装链路;只访问回环地址
- 一套零依赖测试:用 Node 内置的 `node:test` 覆盖分类打分(含排除词、锚定模式与语言判定)、维度合成(同维覆盖、跨维拼接、缺省归 tone、语言维 lang 门)、对比示例读取与注入、资产按类型读取与校验、1.1.0 特性版本门、IndexedDB 快照封装、快照装配与一次性迁移、资产包导入、证书链校验与导入两轴结论、内核装配与请求前接线、市场 slot 描述与动作分发、四处槽位的接线(按钮状态随开关变化、点击后开关落盘、来源不可达时登记通知与恢复后撤销、设置页登记与保存后取件生效)

内核通过宿主的请求前能力落到请求上:有资产时按策略改写请求参数与系统提示词,没有资产时请求保持原样。插件同时记录会话切换,并在首次激活时用宿主文案键提示一次。

## 已接入宿主请求能力

| 模块 | 位置 | 状态 |
|:---:|:---:|:---:|
| 意图分类 | [src/humanize/intent/rule-classifier.ts](../../src/humanize/intent/rule-classifier.ts) | 分类器接口与规则实现可用,输出 (lang, shape) 二元组,支持排除词先行与 ^...$ 锚定模式;ONNX 实现只有接口与 TODO,未引入依赖、未下载模型 |
| 策略引擎 | [src/humanize/strategy/engine.ts](../../src/humanize/strategy/engine.ts) | 标签到策略的合并与校验可用:注入按维度合成(缺省归 tone、同维覆盖、跨维拼接),语言维受语言判定约束;策略内容全部来自资产,内核不内置具体策略 |
| 注入构建 | [src/humanize/injection/builder.ts](../../src/humanize/injection/builder.ts)、[src/humanize/injection/examples.ts](../../src/humanize/injection/examples.ts) | 纯函数:人设前缀、按维度合成的策略注入文本(对比示例插在形状维之后、语言维之前)与注入类型片段的拼接、去重与位置 |
| 资产加载 | [src/humanize/assets/loader.ts](../../src/humanize/assets/loader.ts) | 按包元数据的类型声明读取五类内容,声明与内容双向一致;按包声明的 formatVersion 判定 1.1.0 特性门与主版本;本地数据可用,URL 经注入的 transport 读取,内核不发请求 |
| 资产读取通道 | [src/market/transport.ts](../../src/market/transport.ts)、[src/index.ts](../../src/index.ts) | 激活时把宿主 `context.assets.readText` 包装成内核 transport 注入:content 透传文本,status 按 3.x 口径降级为地址不可用,no-status 与通道拒绝按 transport-failed(无法判定不写成地址无效);宿主没有 assets 成员时保持 transport-missing,本地资产不受影响 |
| 市场来源 | [src/market/sources.ts](../../src/market/sources.ts) | 内置两条来源(合集 id 即证书目录名与结论归属),base_url 按 [asset-market.md](../design/asset-market.md) 2.2 定序,本地联调地址由构建注入、非法时退回线上;地址判定与引擎同口径(https 任意主机、http 仅回环);来源开关与一条自建来源(URL 与合集 id 成对)经设置表面字段存储,来源清单每次取件重新解析 |
| 市场目录 | [src/market/catalog.ts](../../src/market/catalog.ts) | 按 [asset-market.md](../design/asset-market.md) 3.1 目录部分取件:来源元数据 → 合集证书三档 → 内嵌根校链(复用 `verifySourceTrust`)→ assets.json;两种合集元数据形状兼容读取([asset-market.md](../design/asset-market.md) 8.2);拿不到证书只降级来源结论、索引不可读目录为空,均不阻断;签名结论本轮恒为未校验(合集未发布签名材料),来源结论与签名结论互不替代 |
| 市场安装 | [src/market/install.ts](../../src/market/install.ts)、[src/index.ts](../../src/index.ts) | `installMarketPackage` 按包层清单(L3 manifest.json)逐文件取包内文件并比对 SHA-512,扁平化成加载期包文档交给 `importAssetPackage` 整包校验与原子装配;取件或校验失败整包拒绝不落盘;安装记录含合集 id、生效 base_url、作者、包标识、版本、类型集合、两轴结论与清单修订号 |
| 内核装配 | [src/humanize/kernel.ts](../../src/humanize/kernel.ts) | 按类型取来源,串起分类、策略与注入,产出一次规划与来源记录 |
| 宿主请求接线 | [src/host/request-patch.ts](../../src/host/request-patch.ts) | 申请能力 `chat:request` 并声明挂载点 `chat:before-request`,把分类、策略与注入结果映射为宿主补丁;没有标签集或策略表、分类器抛错时返回 `null`,不改请求 |
| 资产交付 | [src/host/snapshot.ts](../../src/host/snapshot.ts)、[src/host/snapshot-db.ts](../../src/host/snapshot-db.ts)、[src/index.ts](../../src/index.ts) | 激活时读取 IndexedDB 里的当前使用快照并装配,一次性迁移插件存储里的过渡快照,`importAssetPackage` 从 JSON 文本导入资产包文档;没有快照或快照不合法时保持空内容,库内约定按 [kernel-and-assets.md](../design/kernel-and-assets.md) 4.6 的初版实现,可调整 |
| 根证书内嵌 | [src/trust/root-ca.ts](../../src/trust/root-ca.ts)、[build.mjs](../../build.mjs) | 构建时读取公开根证书并注入产物常量,运行时导出 PEM;只内嵌公开证书 |
| 证书链校验 | [src/trust/x509.ts](../../src/trust/x509.ts)、[src/trust/source-verdict.ts](../../src/trust/source-verdict.ts) | 零依赖 DER 解析加 WebCrypto 验签:导入带来源证书时先做「根 → EEC」两级链校验并比对证书主题 CN 与包标识,给出签名结论与来源结论;链不过只降级来源结论、不阻断导入 |
| 资产编辑界面 | 尚未实现(导入入口已可用) | 插件还没有界面入口,资产的输入、编辑与导出未落地;导入可先把 JSON 文本交给 `importAssetPackage` |
| 资产包格式 | [src/humanize/types.ts](../../src/humanize/types.ts) | 格式由 `dsc-humanize-asset-template` 定义(格式版本 1.1.0):examples 类型、exclude_keywords、patterns、dimension 与维度合成口径已实现;1.0.0 包完全兼容;导出与编辑界面未实现 |

- 内核只做纯计算:输出意图、策略、提示词片段与来源记录,不写回任何请求,也不读写宿主状态;落地由宿主请求接线完成。
- 宿主请求能力已具备(`chat:request`):清单同时声明挂载点 `chat:before-request`,激活时登记处理器;处理器同步返回 `temperature`、`topP`、`maxTokens`、`stop` 与 `systemPromptAppend`,数值与文本长度不在插件里裁剪,越界由引擎按补丁上限收敛;超时或抛错时整份补丁作废,请求按原参数发出。
- 与 dsc-llm-tune 互斥:两者都改写同一次请求的参数,不能同时启用;清单声明 `conflicts: ['dsc-llm-tune']`,同时安装会被宿主拒绝。职责互补但不并存:本插件按资产给预设,dsc-llm-tune 让用户自由调节参数,互斥口径见 [engineering-handbook.md](engineering-handbook.md) 的「与 dsc-llm-tune 互斥」。
- 资产装载入口:`setActiveContents` 按类型接收当前使用的内容,形状与内核装配参数一致。插件激活时从 IndexedDB 读取当前使用快照(库 `dsc-humanize`、对象仓库 `snapshot`、记录键 `active`,形状见 [kernel-and-assets.md](../design/kernel-and-assets.md) 4.6 的初版约定),校验通过后装配;没有快照或快照不合法时保持空内容,插件不改请求。激活时若 IndexedDB 里没有记录,会把插件存储里的过渡快照(旧键 `dsc-humanize/snapshot/v1`)一次性迁入并删除旧键,迁移失败不阻断激活。`importAssetPackage` 从 JSON 文本导入一份加载期资产包文档,成功才整体替换当前内容,并在已激活且 IndexedDB 可用时写回快照(上限 2 MB,超限或写入失败只影响持久化,不影响本次装配);导入可带来源证书(`sourceCertPem`),带证书时先做「根 → EEC」链校验并返回两轴结论,链不过只把来源结论降级为未通过,不阻断导入;资产的编辑界面与导出仍未实现。
- 资产包格式已由 `dsc-humanize-asset-template` 定义(格式版本 1.1.0),内核按包元数据的类型声明读取五类内容,声明与实际内容双向一致;1.1.0 的新特性(examples 类型、exclude_keywords、patterns、dimension 与维度合成)已实现,按包声明的 formatVersion 判定特性门,1.0.0 包行为不变;导入入口已可用(JSON 文本交给 `importAssetPackage`),导出与编辑界面尚未实现,`dsc-humanize-inner-asset` 的预设包仍需先转成加载期包文档才能导入。
- 编辑界面未实现:插件目前没有界面入口,人性化资产的输入、编辑与一比一导出都还没有落地;导入已可用,但需要调用方提供 JSON 文本。
- 自检覆盖类型、构建、规范、内核纯函数与请求前接线:`pnpm run type`、`pnpm run build`、`pnpm run validate:specs`、`pnpm run test`;市场链路另有本地回环冒烟:`node --import ./scripts/test/ts-hooks.mjs scripts/smoke-market.mjs`。

## 资产市场

入口路径:会话视图标签栏里的资产市场标签。标签已按 ui:slot 落地:插件只交描述、不交控件,渲染、i18n 与样式全部归宿主,宿主插槽细节以引擎文档为准。

| 区块 | 内容 | 行为 |
|:---:|:---:|:---:|
| text | 两轴结论与来源表单口径说明 | 来源是否可信与签名是否通过各管一条轴,互不替代;页面表单草稿不落盘,持久保存走插件设置页 |
| list「目录」 | 按已启用来源列出各合集的包:标题=包名、描述=作者与类型集合、徽标=来源名 | 每条目挂「安装」动作,分发到 `installMarketPackage`,完成用气泡通知提示成功或失败,不用任何弹窗与遮罩 |
| form「来源」 | 内置两来源开关 + 自建来源 URL 与合集 id,字段与插件设置页同源(复用同一份字段描述) | 草稿值随动作载荷交给插件,在本会话内的取件与安装即时生效但不落盘;持久保存走「界面槽位」节里的资产来源设置页(设置 → 插件 → 资产来源),两个表面不各自漂移 |
| actions | 「刷新目录」 | 返回刷新指示,宿主重新索取模型;本次取件绕过缓存 |

- 取件与刷新:数据挂载点每次索取模型都走既有 catalog 层补取件(来源元数据 → 合集证书 → assets.json),目录结果做内存短缓存,时长 5 分钟(对齐 [asset-market.md](../design/asset-market.md) 8.1 的内存缓存建议);缓存时效内的重复索取不重复取件,以平衡 assets:read 的 20 次 / 10 秒与 settings:surface 的 60 次 / 10 秒预算。宿主索取模型是同步回调,首次进入标签先显示「读取中」占位,取件完成后在下一次索取模型或刷新指示时看到目录。
- 失败降级:某个来源取件失败(所有地址不可达、通道缺失、索引不可读)时,该来源在目录里折叠成一行说明,徽标标「来源不可用」,其余来源照常列出——遵守「只提示不阻断」;目录条目超过宿主描述的体积上限(8KB)时从尾部收敛条目并补一条截断说明。
- 安装:动作按条目登记表把 itemKey 还原成来源、作者与包标识,再交给 `installMarketPackage`(与设置页面的来源解析同一条路径,两轴结论每次安装重新计算);成功与失败都用宿主为资产包新增的成对文案键出气泡通知——成功走 `pluginAssetInstalled`(资产包 {id} 安装完成),失败走 `pluginAssetInstallFailed`(资产包 {id} 安装失败:{reason}),不弹窗、不遮罩;旧键 `pluginInstalled` / `pluginInstallRejected` 属于插件安装,不再复用。宿主版本要求:宿主需已提供这对资产专用键(`notify` 只写不读,插件探测不到宿主字典,故不做缺键回落);更早的宿主上气泡取不到文案,安装本身照常完成。

## 界面槽位

四处槽位(ui:slot)都由插件在激活期登记一份声明式描述,渲染、i18n 与样式全部归宿主;插件不交控件,也不做任何路由、弹窗或遮罩。

| 槽位 | 落点 | 本插件的条目 | 行为 |
|:---:|:---:|:---:|:---:|
| `conversation.tabs` | 会话视图标签栏 | `asset-market`(order 50) | 资产市场整页,见上一节 |
| `settings.page` | 系统设置的「插件」分组 | `asset-sources`(order 100) | 资产来源设置页:来源开关与自建来源表单 + 保存,见下一节 |
| `composer.toolbar` | 输入框下方工具条 | `rewrite-switch`(order 50) | 「人性化 · 开 / 关」按钮:点击翻转「是否启用资产改写」 |
| `overlay.notice` | 右上角通知栈 | `asset-state`(order 50,level `warning`) | 只在资产来源不可达或资产包不可用时登记,说明原因 |

### 资产来源设置页

入口路径:设置 → 插件 → 资产来源。宿主只在有 `settings.page` 登记项时才显示「插件」分组,点进条目后在同一分组内渲染该页面,并有「返回插件列表」。

| 区块 | 内容 | 行为 |
|:---:|:---:|:---:|
| form「来源」 | 两个内置来源开关 + 自建来源 URL 与合集 id,字段直接复用 `marketSettingDescriptor.fields` | 与资产市场标签里的表单、`settings:surface` 登记的表单是同一份字段描述,三个表面不各自漂移;字段默认值按当前生效值回填,打开页面看到的就是正在生效的配置 |
| text | 保存口径说明 | 沿用既有口径:页面内改动即时生效但不落盘,保存走本页的「保存来源配置」 |
| actions | 「保存来源配置」 | 动作载荷带表单草稿;插件把草稿写进插件设置后返回刷新指示,宿主重新索取模型 |

| 项 | 内容 |
|:---:|:---:|
| 动作 | `ui:slot-action`,载荷 `slot` 为 `settings.page`、`id` 为 `asset-sources`、`actionId` 为 `save-sources`,`form` 是宿主收集的当前草稿 |
| 存储 | 独立键 `dsc-humanize/asset-sources/v1`,记录形状 `{ version: 1, values }`;与快照、安装记录(`dsc-humanize/market/v1`)和人性化开关(`dsc-humanize/rewrite/v1`)分开,四份数据生命周期不同 |
| 生效时机 | 保存后立即参与来源解析,下一次取件即按新来源取件;保存时清空目录短缓存,来源范围变化(新增自建来源、关掉内置来源)不必等缓存过期 |
| 值优先级 | 设置页保存值 → 宿主 `settings:surface` 的生效值 → 字段缺省。插件侧的设置面只读(只有 `register` 与 `values`),读不到宿主的「是否被用户覆盖」,所以只能按可写侧在前定序;两个表面读到的是同一份生效值 |
| 与市场标签草稿的关系 | 保存时清掉资产市场标签里同字段的旧草稿:两个表面是同一份字段,设置页的保存是更晚的一次完整提交,旧草稿不再代表用户意图 |
| 读取口径 | 键缺失、形状不符或版本不符都按「没有保存值」处理(回落到宿主设置值),不做部分保留;写失败只记日志,本次会话内仍生效 |
| 登记失败 | 宿主没有 `ui:slot` 或登记被拒时只记日志,设置入口不出现,不阻断激活 |

### 人性化按钮

| 项 | 内容 |
|:---:|:---:|
| 文案 | `人性化 · 开` / `人性化 · 关`(英文 `Humanize · on` / `Humanize · off`)。宿主 `composer.toolbar` 的描述只有一个文案字段,没有独立徽标位,因此状态并入文案:文案在前、状态在后 |
| 动作 | 点击经 `ui:slot-action` 回到插件,载荷 `slot` 为 `composer.toolbar`、`actionId` 为 `toggle` |
| 存储 | 开关值存插件存储的独立键 `dsc-humanize/rewrite/v1`,记录形状 `{ version: 1, enabled }`;与快照(IndexedDB,旧键 `dsc-humanize/snapshot/v1` 仅作迁移)和安装记录(`dsc-humanize/market/v1`)分开,三份数据互不影响 |
| 刷新 | 翻转后按同 id 重新 `registerSlot`:宿主对同插件同 id 是替换语义,按钮文字随之刷新;工具条没有页面模型,不用刷新指示 |
| 气泡 | 每次点击一次气泡,宿主文案键 `pluginHumanizeRewriteToggled`,参数 `{state}`(`开启` / `关闭`);不弹窗、不遮罩 |
| 与请求的关系 | 打开(缺省):请求前处理器按既有行为改写请求;关闭:处理器第一句就返回 `null`,连资产内容都不读,请求按原样发出 |
| 存储读取口径 | 缺键、形状不符或版本不符都回落到缺省(开启),不做部分保留;写失败只记日志,本次会话内仍生效 |

宿主版本要求:宿主字典需提供一条形如「人性化改写已{state}」的键 `pluginHumanizeRewriteToggled`。缺该键时宿主 i18n 的缺键口径是显示键名本身(`notify` 只写不读,插件探测不到字典),状态与改写行为都不受影响。

### 资产状态通知

| 项 | 内容 |
|:---:|:---:|
| 何时登记 | 两个真实问题:已启用来源全部取件失败(或宿主没有 `assets:read` 读取通道,或没有已启用的来源);当前装配的资产包不可用(五类条目一条都没有,或内容不完整、缺标签集与策略表,导致改写无法生效) |
| 何时撤销 | 两个问题都不再成立时撤销该登记;正文变化时按同 id 重新登记,正文不变不重复登记(避免把 `ui:slot` 的登记次数耗在重复刷新上) |
| 条数 | 只登记一条,把当前所有原因写进同一段正文;宿主按插件把多条通知合并成一张卡片,这里不需要逐条罗列 |
| 强度 | `warning`:功能暂不可用,插件本身没坏(不用 `error`) |
| 正文 | 直给文案(`text`)不走宿主文案键:原因里带错误码与可读摘要,键承载不了;按宿主 2000 字符上限收敛 |
| 不误报 | 「还没有取件结论」不算不可达:只有真的取了且全失败才登记;任一来源成功即视为可达,单来源失败由资产市场标签里的逐行说明承担 |
| 与请求的关系 | 只说明原因,不改请求、不阻断安装:改写是否生效仍由开关与资产内容决定 |