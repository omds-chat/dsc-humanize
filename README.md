# dsc-humanize

[简体中文] | [English](README.en-US.md)

dsc-humanize 是一个 dsc 插件,目的是让 ds-chat 里的助手更接近你期望的样子。插件本身不承诺把助手变成某种固定形态:助手该是什么样子,由你在插件界面里输入与编辑。

在这个定位下,插件要做的是对人性化资产的完整编辑能力:界面里能设置的属性覆盖资产的每一项,编辑结果可以一比一导出为标准 `dsc-humanize-asset` 资产包,也能把该格式的资产包一比一导入,因此不存在用户无法设置的属性。`dsc-humanize-inner-asset` 只提供可导入的预设资产包,是资产来源之一,不改变插件本身的定位。

工程结构沿用 dsc-plugin-template:用 TypeScript 写源码,用 esbuild 打包成单个浏览器 ESM 文件;构建同时产出运行时元数据,可选地为 `plugin.js` 产出作者签名,产物可以直接在 DeepSeek-Chat-Enhanced 中从地址安装。

## 仓库现状

- 从 dsc-plugin-template 复制来的工程骨架:清单、激活、停用
- 一份契约类型的本地副本,脱离 DeepSeek-Chat-Enhanced 源码也有类型提示
- 一套构建流程:打包 `plugin.js`、生成并自校验 `meta.json`、写入 `MUST_PLUSH_WITH_PACKAGE` 标记
- 一条可选的作者签名链路:打开开关后用 openssl 对 `plugin.js` 生成 `.author.sig`
- 文本产物强制 LF 换行,`plugin.js` 默认行压缩
- 一套可校验的规范区:运行时规范、开发规范与 JSON Schema,随仓库保留用于本地校验
- 一套内核骨架:意图分类、标签到策略的解析、提示词注入拼接与按类型读取的资产适配层,不依赖模型与宿主能力
- 一套宿主请求前接线:申请 `chat:request` 能力并声明 `chat:before-request` 挂载点,把内核的策略与注入结果映射成宿主补丁
- 一条本地资产交付路径:激活时从 IndexedDB 读取当前使用快照并装配,并把插件存储里的过渡快照一次性迁入,另有 `importAssetPackage` 从 JSON 文本导入资产包文档;快照的库内约定按设计文档 4.6 的初版实现,标注为可调整
- 一条根证书内嵌与链校验链路:构建时读取 `certs/dsc-humanize/dsc-humanize-root-ca.crt`,把 PEM 注入为产物常量,运行时导出 `EMBEDDED_ROOT_CA_PEM`;`importAssetPackage` 带来源证书时先用它做「根 → EEC」两级链校验,按两轴结论(签名结论 + 来源结论)降级来源结论、不阻断导入
- 一套零依赖测试:用 Node 内置的 `node:test` 覆盖分类打分、策略合并、注入拼接、资产按类型读取与校验、IndexedDB 快照封装、快照装配与一次性迁移、资产包导入、证书链校验与导入两轴结论、内核装配与请求前接线

内核通过宿主的请求前能力落到请求上:有资产时按策略改写请求参数与系统提示词,没有资产时请求保持原样。插件同时记录会话切换,并在首次激活时用宿主文案键提示一次。

## 已接入宿主请求能力

| 模块 | 位置 | 状态 |
|:---:|:---:|:---:|
| 意图分类 | [src/humanize/intent/rule-classifier.ts](src/humanize/intent/rule-classifier.ts) | 分类器接口与规则/关键词实现可用;ONNX 实现只有接口与 TODO,未引入依赖、未下载模型 |
| 策略引擎 | [src/humanize/strategy/engine.ts](src/humanize/strategy/engine.ts) | 标签到策略的合并与校验可用,策略内容全部来自资产,内核不内置具体策略 |
| 注入构建 | [src/humanize/injection/builder.ts](src/humanize/injection/builder.ts) | 纯函数:人设前缀、策略注入文本与注入类型片段的拼接、去重与位置 |
| 资产加载 | [src/humanize/assets/loader.ts](src/humanize/assets/loader.ts) | 按包元数据的类型声明读取,声明与内容双向一致;本地数据可用,URL 只留读取通道接口,内核不发请求 |
| 内核装配 | [src/humanize/kernel.ts](src/humanize/kernel.ts) | 按类型取来源,串起分类、策略与注入,产出一次规划与来源记录 |
| 宿主请求接线 | [src/host/request-patch.ts](src/host/request-patch.ts) | 申请能力 `chat:request` 并声明挂载点 `chat:before-request`,把分类、策略与注入结果映射为宿主补丁;没有标签集或策略表、分类器抛错时返回 `null`,不改请求 |
| 资产交付 | [src/host/snapshot.ts](src/host/snapshot.ts)、[src/host/snapshot-db.ts](src/host/snapshot-db.ts)、[src/index.ts](src/index.ts) | 激活时读取 IndexedDB 里的当前使用快照并装配,一次性迁移插件存储里的过渡快照,`importAssetPackage` 从 JSON 文本导入资产包文档;没有快照或快照不合法时保持空内容,库内约定按 4.6 的初版实现,可调整 |
| 根证书内嵌 | [src/trust/root-ca.ts](src/trust/root-ca.ts)、[build.mjs](build.mjs) | 构建时读取公开根证书并注入产物常量,运行时导出 PEM;只内嵌公开证书 |
| 证书链校验 | [src/trust/x509.ts](src/trust/x509.ts)、[src/trust/source-verdict.ts](src/trust/source-verdict.ts) | 零依赖 DER 解析加 WebCrypto 验签:导入带来源证书时先做「根 → EEC」两级链校验并比对证书主题 CN 与包标识,给出签名结论与来源结论;链不过只降级来源结论、不阻断导入 |
| 资产编辑界面 | 尚未实现(导入入口已可用) | 插件还没有界面入口,资产的输入、编辑与导出未落地;导入可先把 JSON 文本交给 `importAssetPackage` |
| 资产包格式 | [src/humanize/types.ts](src/humanize/types.ts) | 格式由 `dsc-humanize-asset-template` 定义(格式版本 1.0.0);内核按类型读取与导入已实现,导出与编辑界面未实现 |

- 内核只做纯计算:输出意图、策略、提示词片段与来源记录,不写回任何请求,也不读写宿主状态;落地由宿主请求接线完成。
- 宿主请求能力已具备(`chat:request`):清单同时声明挂载点 `chat:before-request`,激活时登记处理器;处理器同步返回 `temperature`、`topP`、`maxTokens`、`stop` 与 `systemPromptAppend`,数值与文本长度不在插件里裁剪,越界由引擎按补丁上限收敛;超时或抛错时整份补丁作废,请求按原参数发出。
- 与 dsc-llm-tune 互斥:两者都改写同一次请求的参数,不能同时启用;清单声明 `conflicts: ['dsc-llm-tune']`,同时安装会被宿主拒绝。职责互补但不并存:本插件按资产给预设,dsc-llm-tune 让用户自由调节参数,详见下文「与 dsc-llm-tune 互斥」。
- 资产装载入口:`setActiveContents` 按类型接收当前使用的内容,形状与内核装配参数一致。插件激活时从 IndexedDB 读取当前使用快照(库 `dsc-humanize`、对象仓库 `snapshot`、记录键 `active`,形状见设计文档 4.6 的初版约定),校验通过后装配;没有快照或快照不合法时保持空内容,插件不改请求。激活时若 IndexedDB 里没有记录,会把插件存储里的过渡快照(旧键 `dsc-humanize/snapshot/v1`)一次性迁入并删除旧键,迁移失败不阻断激活。`importAssetPackage` 从 JSON 文本导入一份加载期资产包文档,成功才整体替换当前内容,并在已激活且 IndexedDB 可用时写回快照(上限 2 MB,超限或写入失败只影响持久化,不影响本次装配);导入可带来源证书(`sourceCertPem`),带证书时先做「根 → EEC」链校验并返回两轴结论,链不过只把来源结论降级为未通过,不阻断导入;资产的编辑界面与导出仍未实现。
- 资产包格式已由 `dsc-humanize-asset-template` 定义(格式版本 1.0.0),内核按包元数据的类型声明读取,声明与实际内容双向一致;导入入口已可用(JSON 文本交给 `importAssetPackage`),导出与编辑界面尚未实现,`dsc-humanize-inner-asset` 的预设包仍需先转成加载期包文档才能导入。
- 编辑界面未实现:插件目前没有界面入口,人性化资产的输入、编辑与一比一导出都还没有落地;导入已可用,但需要调用方提供 JSON 文本。
- 自检覆盖类型、构建、规范、内核纯函数与请求前接线:`pnpm run type`、`pnpm run build`、`pnpm run validate:specs`、`pnpm run test`。

## 规范与 Schema

插件运行时规范、插件开发规范与配套 JSON Schema 随本仓库一并保留,用于本地校验与分发前对照;规范内容来自 dsc-plugin-template,权威实现仍是 DeepSeek-Chat-Enhanced 的 `dsc-plugin-engine`:

| 内容 | 位置 |
|:---:|:---:|
| 规范区索引与已知差异 | [specs/README.md](specs/README.md) |
| 插件运行时规范 | [specs/plugin-runtime-spec.md](specs/plugin-runtime-spec.md) |
| 插件开发规范 | [specs/plugin-develop-spec.md](specs/plugin-develop-spec.md) |
| 规范版本与 Schema 路径 | [specs/spec-version.json](specs/spec-version.json) |
| 清单 Schema | [schemas/manifest/plugin-manifest.schema.json](schemas/manifest/plugin-manifest.schema.json) |
| 运行时 meta Schema | [schemas/runtime/meta.json](schemas/runtime/meta.json) |

- 规范以 DeepSeek-Chat-Enhanced 的 `dsc-plugin-engine` 实现为准,本仓库只做收拢与机器可校验化,不新增规则;两侧口径不一致时记录在 [specs/README.md](specs/README.md) 的「已知差异」。
- 本仓库不对外发布规范版本;需要引用规范的其他仓库请使用 dsc-plugin-template 的 `specs/spec-version.json`,并用 git 标签或提交固定,不要引用浮动分支;改规范时先改规范与 Schema,再升版本号。
- 校验命令:`node scripts/validate-specs.mjs`(自检),`node scripts/validate-specs.mjs <清单文件>`(校验单个清单),不联网、不安装依赖。

## 目录结构

```text
dsc-humanize/
├── .env.example              # 环境变量模板:作者签名与本地联调地址
├── .gitattributes            # 全仓库统一 LF
├── .gitignore
├── .npmrc
├── COPYRIGHT                 # 版权声明
├── LICENSE
├── README.md                 # 面向开发者,由插件作者维护
├── README.user.md            # 面向普通用户,由插件作者维护
├── README.en-US.md           # 英文版,与 README.md 同步维护
├── build.mjs                 # 构建入口
├── package.json              # 工程信息,meta.json 的数据来源
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.json
├── schemas/
│   ├── examples/             # Schema 的正例与反例
│   ├── manifest/
│   │   └── plugin-manifest.schema.json # 清单 schema
│   └── runtime/
│       └── meta.json         # runtime meta schema
├── scripts/
│   ├── test/                 # 内核纯函数测试,node:test 运行
│   │   ├── ts-hooks.mjs      # 让测试直接加载 .ts 源码的解析钩子
│   │   ├── asset-delivery.test.ts # 快照装配、一次性迁移与资产包导入
│   │   ├── asset-loader.test.ts
│   │   ├── fake-idb.ts        # 测试用的假 IndexedDB 替身
│   │   ├── host-wiring.test.ts # 宿主请求前接线
│   │   ├── injection-builder.test.ts
│   │   ├── kernel.test.ts
│   │   ├── rule-classifier.test.ts
│   │   ├── snapshot-db.test.ts # IndexedDB 快照封装
│   │   ├── strategy-engine.test.ts
│   │   └── trust-chain.test.ts # 证书链校验与导入两轴结论
│   └── validate-specs.mjs    # 零依赖规范校验脚本
├── specs/
│   ├── README.md             # 规范区索引与已知差异
│   ├── plugin-develop-spec.md # 插件开发规范
│   ├── plugin-runtime-spec.md # 插件运行时规范
│   └── spec-version.json     # 规范版本与 Schema 路径
├── src/
│   ├── env.d.ts              # 构建期全局常量声明
│   ├── index.ts              # 激活与停用入口,快照装配与资产包导入
│   ├── manifest.ts           # 运行时清单
│   ├── types.ts              # 契约类型
│   ├── host/
│   │   ├── request-patch.ts  # 宿主请求前接线:策略与注入 -> 请求补丁
│   │   ├── snapshot-db.ts    # 当前使用快照的 IndexedDB 封装:库名、仓库与读写
│   │   └── snapshot.ts       # 当前使用快照:形状、版本与读取校验,含过渡快照旧键
│   ├── trust/
│   │   ├── root-ca.ts        # 内嵌的资产根证书 PEM 常量
│   │   ├── x509.ts           # 零依赖 X.509 解析与 WebCrypto 链校验
│   │   └── source-verdict.ts # 导入路径的两轴结论:签名结论 + 来源结论
│   └── humanize/             # 内核骨架,不接宿主
│       ├── index.ts          # 内核对外出口
│       ├── kernel.ts         # 内核装配:分类 -> 策略 -> 注入
│       ├── types.ts          # 内核公共类型
│       ├── assets/
│       │   └── loader.ts     # 资产读取适配层
│       ├── injection/
│       │   └── builder.ts    # 提示词片段拼接
│       ├── intent/
│       │   ├── onnx-classifier.ts # ONNX 分类器占位,仅接口
│       │   └── rule-classifier.ts # 规则分类器,默认可用
│       └── strategy/
│           └── engine.ts     # 标签到策略的解析
└── dist/                     # 构建产物,已被 .gitignore 忽略
```

| 文件 | 作用 |
|:---:|:---:|
| `build.mjs` | 构建入口:打包、生成 `meta.json`、自校验、可选作者签名 |
| `package.json` | 工程信息与 `meta.json` 的数据来源 |
| `src/index.ts` | 激活与停用入口,快照装配与资产包导入 |
| `src/manifest.ts` | 插件运行时清单,产物继续导出 |
| `src/host/` | 宿主请求接线与资产交付:申请 `chat:request` 把内核结果映射成宿主补丁;读取当前使用快照 |
| `src/trust/` | 内嵌的资产根证书常量与来源证书链校验:零依赖 DER 解析、WebCrypto 验签与导入两轴结论 |
| `src/humanize/` | 内核骨架:意图分类、策略引擎、注入构建与资产加载,不读写宿主 |
| `schemas/manifest/` | 清单 JSON Schema,与宿主的清单校验规则对齐 |
| `schemas/runtime/` | 运行时 meta 的 JSON Schema,构建自校验覆盖其中的必填与格式规则 |
| `scripts/validate-specs.mjs` | 零依赖校验脚本,校验 Schema、样例与本仓库 meta |
| `scripts/test/` | 测试:分类打分与排序、策略校验与合并、注入拼接、资产按类型读取与校验、快照装配与资产包导入、证书链校验、内核装配、宿主请求前接线 |
| `specs/` | 规范区:运行时规范、开发规范与版本信息 |
| `.env.example` | 环境变量模板 |

## 环境要求

| 项 | 要求 |
|:---:|:---:|
| Node.js | 18 或更高版本,跑测试需要 22.18 或更高版本 |
| pnpm | 12 或更高版本 |
| OpenSSL | 3.0 或更高版本,仅启用作者签名时需要 |
| 产物目标浏览器 | Chrome 105、Edge 105、Safari 16、Firefox 110 |

pnpm 12 默认不执行依赖的安装脚本,仓库里的 `pnpm-workspace.yaml` 通过 `allowBuilds` 显式允许 esbuild 的构建脚本,请不要删除这个文件。

## 快速开始

```bash
git clone https://github.com/omds-chat/dsc-humanize.git
cd dsc-humanize
pnpm install
pnpm run type
pnpm run build
pnpm run test
```

| 命令 | 作用 |
|:---:|:---:|
| `pnpm install` | 安装开发依赖 |
| `pnpm run type` | 运行 `tsc --noEmit` 做类型检查 |
| `pnpm run build` | 构建全部产物 |
| `pnpm run build -- --no-minify` | 关闭行压缩后再构建 |
| `pnpm run validate:specs` | 校验规范区的 Schema、样例与本仓库 meta 数据 |
| `pnpm run test` | 运行 `node --test` 的内核测试 |

测试用 Node 内置的 `node:test`,零依赖、离线可跑,直接加载 `src` 下的 TypeScript 源码,因此需要 Node 22.18 或更高版本(内置类型剥离);改完内核后跑 `pnpm run test` 即可。

`build.mjs` 支持 `--no-minify` 一个参数,关闭 esbuild 的行压缩。压缩后的产物体积明显更小,分发时建议保持默认压缩。

## 构建产物

构建先清空 `dist/`,再依次产出以下文件:

```text
dist/
├── meta.json                  # 运行时元数据,从 package.json 生成
├── plugin.js                  # 运行时脚本,单文件 ESM
├── plugin.js.author.sig       # plugin.js 的作者分离签名,仅在启用作者签名时产出
├── author_pub.pem             # 作者公钥,仅在启用作者签名时产出,交给合集
└── MUST_PLUSH_WITH_PACKAGE    # 标记文件,内容为空
```

| 产物 | 何时产出 | 说明 |
|:---:|:---:|:---:|
| `meta.json` | 每次构建 | 生成后立即按 `schemas/runtime/meta.json` 的规则自校验,不通过则构建失败 |
| `plugin.js` | 每次构建 | 单文件 ESM,导出 `manifest` 与 `activate` |
| `plugin.js.author.sig` | 仅启用作者签名时 | `plugin.js` 的裸公钥分离签名,64 字节二进制 |
| `author_pub.pem` | 仅启用作者签名时 | 由私钥推导出的 Ed25519 公钥,交给插件合集 |
| `MUST_PLUSH_WITH_PACKAGE` | 每次构建 | 空文件,表示该目录内容必须随包分发 |

文件名按约定原样保留,`MUST_PLUSH_WITH_PACKAGE` 的拼写不要改成 `PUSH`。

构建结束时脚本会打印每个产物的大小、压缩开关、签名状态,并检查 `dist/` 里没有预期之外的文件。文本产物(`meta.json`、`plugin.js`、`author_pub.pem`)按 LF 落盘,若检测到 CR 字节直接报错;`.author.sig` 是二进制签名,不参与换行检查。

构建还会读取 [certs/dsc-humanize/dsc-humanize-root-ca.crt](certs/dsc-humanize/dsc-humanize-root-ca.crt),把公开根证书 PEM 注入 `plugin.js` 的常量。文件缺失或不是 PEM 证书时构建失败;产物写盘后会检查 PEM 头与证书体的一段是否真的进了 bundle,没进也失败。只内嵌公开证书,根私钥不入仓库,也不进产物。

## meta.json 生成规则

`meta.json` 由 `package.json` 生成,不手工维护。

| `meta.json` 字段 | 来源 | 必填 |
|:---:|:---:|:---:|
| `name` | `package.json` 的 `name` | 是 |
| `version` | `package.json` 的 `version` | 是 |
| `license` | `package.json` 的 `license` | 是 |
| `author` | `package.json` 的 `author`,字符串形式 | 是 |
| `description` | `dsc.description`,对象,至少含 `zh-CN` 或 `en-US` | 是 |
| `repo_link` | `dsc.repo_link` | 是 |
| `dependencies.dsc` | `dsc.engines` | 是 |
| `conflicts` | `dsc.conflicts`,缺省则不写 | 否 |
| `home_page` | `dsc.home_page`,缺省则不写 | 否 |
| `attached` | `dsc.attached`,缺省则不写 | 否 |

`package.json` 里的 `dsc` 块:

```json
"dsc": {
  "engines": "^1.0.0",
  "conflicts": ["dsc-llm-tune"],
  "description": {
    "zh-CN": "让 ds-chat 里的助手更接近你期望的样子,助手形态由你在插件内输入与编辑;当前仅内核骨架,编辑界面尚未实现;资产包格式由 dsc-humanize-asset-template 定义",
    "en-US": "Aims to bring the assistant in ds-chat closer to what you expect, with the form you enter and edit in the plugin; kernel skeleton only, the editing UI is not built yet; the asset package format is defined by dsc-humanize-asset-template"
  },
  "home_page": "https://github.com/omds-chat/dsc-humanize",
  "repo_link": "https://github.com/omds-chat/dsc-humanize"
}
```

改插件名时同步改 `package.json` 的 `name`:它必须匹配 `dsc-xxx` 或 `@scope/dsc-xxx`,否则 `meta.json` 校验失败。改版本时同步改 `version`,只允许 `x.y.z` 三段数字。

## 作者签名

作者签名是裸公钥分离签名:Ed25519 私钥直接对文件原始字节签名,签名文件与被签名文件同名,追加 `.author.sig` 后缀。生成公钥、签名、验签全部交给 `openssl` 子进程完成,构建脚本不依赖任何 JS 密码库。

作者签名只覆盖 `plugin.js`。`meta.json` 的完整性由插件合集的三层哈希清单校验,作者不必为它签名:构建不产出 `meta.json.author.sig`,合集也不接收该文件。

```bash
# 一次性:生成作者密钥对
openssl genpkey -algorithm ed25519 -out author_secret.pem
openssl pkey -in author_secret.pem -pubout -out author_pub.pem

cp .env.example .env
# 编辑 .env,把 YOURS 换成 author_secret.pem 的 PKCS#8 PEM 内容,或写相对路径 author_secret.pem
pnpm run build
```

`build.mjs` 启动时读取仓库根目录的 `.env`,已存在的环境变量优先,因此也可以直接在命令行传入。

| 环境变量 | 取值 | 说明 |
|:---:|:---:|:---:|
| `AUTHOR_SIGN_ENABLE` | `true` | 只有 `true` 才启用作者签名(忽略大小写与首尾空格),其他取值视为关闭 |
| `AUTHOR_SIGN_PRIVATE_KEY` | PKCS#8 PEM | Ed25519 私钥内容,也接受私钥文件路径 |

启用后,构建只对 `plugin.js` 生成一条签名,等价于手工执行:

```bash
openssl pkeyutl -sign -rawin -inkey author_secret.pem -in dist/plugin.js -out dist/plugin.js.author.sig
```

签名对象是落盘后的原始字节,不做换行规范化。签名完成后,构建用推导出的公钥逐条自检,任何一条不通过都直接让构建失败:

```bash
openssl pkeyutl -verify -pubin -inkey dist/author_pub.pem -rawin -in dist/plugin.js -sigfile dist/plugin.js.author.sig
```

启用签名时同时产出 `dist/author_pub.pem`,它由私钥推导得到,不需要手工导出;未启用签名时不产出该文件,也不产出任何 `.author.sig`。

私钥可以写成一行,把换行写成字面量 `\n`,也可以只写私钥文件的相对路径,构建脚本会读取文件内容。

### 公钥交付

作者公钥由作者本人交给插件合集,合集按 `plugins/<作者>/author_pub.pem` 存放,用于校验该作者全部版本的 `.author.sig`。

| 交付物 | 来源 | 合集侧位置 |
|:---:|:---:|:---:|
| `author_pub.pem` | 构建产出的 `dist/author_pub.pem` | `plugins/<作者>/author_pub.pem` |
| `plugin.js.author.sig` | 构建产出的 `dist/plugin.js.author.sig` | 与 `plugin.js` 同目录 |

构建结束时会打印一行提示,提醒作者把 `dist/author_pub.pem` 交给合集。

### 与合集签名的关系

作者签名与合集签名是两层独立的签名,互不替代:

| 签名 | 签名者 | 产物 | 信任来源 |
|:---:|:---:|:---:|:---:|
| 作者签名 | 插件作者 | `plugin.js.author.sig` | 作者公钥 `plugins/<作者>/author_pub.pem` |
| 合集签名 | 插件合集 | `plugin.js.sig`、各层 `manifest.json.sig` | 根 CA 签发的合集证书 `certs/<来源 id>/<来源 id>-eec.crt` |

合集签名只有两类:CMS 格式的 `plugin.js.sig`,以及每层 `manifest.json` 对应的 `manifest.json.sig`。`meta.json` 不再单独签名,它的完整性由合集的三层哈希清单校验。合集证书按 `certs/<来源 id>/<来源 id>-eec.crt` 布局存放,随合集页面分发,不参与任何清单;根目录的 `eec.pem` 只是待删除的兼容回退,新内容不要使用。

作者只负责产出 `.author.sig` 与 `author_pub.pem`。上述 `*.sig` 由合集在收录时用 EEC 证书生成,作者不要自己产出,也不要把 `.author.sig` 改名成 `.sig`。

## 把产物装进 DeepSeek-Chat-Enhanced

用于在本地验证构建结果:

1. 用本地静态服务器提供 `dist/` 目录,例如 `http://localhost:8090/`。
2. 在插件面板的「从地址安装」中填入 `plugin.js` 的地址并安装;安装成功后插件自动激活,状态显示为「运行中」。
3. 打开「查看日志」可以看到 `context.log` 写入的内容,切换会话后日志会追加一条。

面向普通用户的说明见 [README.user.md](README.user.md)。

地址规则:分发给用户时使用 `https://` 地址。本地调试时 DeepSeek-Chat-Enhanced 允许 `http://localhost`、`http://127.0.0.1` 与 `http://[::1]`,其余地址必须是 `https://`。

安装记录会保存产物的代码文本,启动恢复不再取件;产物改动后需要先在面板卸载再重新安装,才会重新取回新字节。

部署要求:宿主安装时用 `fetch` 取产物字节,再按 UTF-8 文本保存,因此托管方必须返回 `Access-Control-Allow-Origin` 响应头,例如 `Access-Control-Allow-Origin: *`,否则插件产物托管在另一个源时取件会被拒绝,安装失败。取件默认不携带凭证,不需要 `Access-Control-Allow-Credentials`;把产物与页面放在同一域名下同源部署,则不需要该响应头。

## 本地联调地址

跨仓库离线联调时,先在仓库根目录建一份 `.env`:

```bash
cp .env.example .env
```

| 变量 | 本地取值 | 说明 |
|:---:|:---:|:---:|
| `DS_CHAT_PAGES_LINK` | `http://127.0.0.1:61117` | 对话页面地址 |
| `DSC_INNER_PLUGIN_PAGES_LINK` | `http://127.0.0.1:61118` | 内测插件页地址 |
| `AWESOME_DSC_PLUGIN_PAGES_LINK` | `http://127.0.0.1:61119` | 插件合集页地址 |

这三个取值是本地联调用的回环地址,不是分发地址;对外分发仍按上文规则使用 `https://`。

本仓库只消费这些地址做联调,不写入产物:`build.mjs` 不读取它们,`dist/` 下的文件与 `meta.json` 都不含这些取值。`.env` 已被 `.gitignore` 忽略,不会进 git;`.env.example` 随仓库提交,只放示例取值。

## 如何改 manifest

清单写在 [src/manifest.ts](src/manifest.ts),由 [src/index.ts](src/index.ts) 转出为具名导出,安装时以产物自带的 `manifest` 为准。

| 字段 | 必填 | 说明 |
|:---:|:---:|:---:|
| `id` | 是 | 插件标识,须匹配 `^[a-z][a-z0-9-]{2,63}$`,仓库约定以 `dsc-` 开头 |
| `name` | 是 | 展示名称,不得为空 |
| `version` | 是 | 插件自身版本,只允许三段数字,例如 `0.1.0` |
| `engines` | 否 | 兼容的 dsc-core 版本范围,支持 `^`、`~`、`>=`、`<=` 与精确版本 |
| `dependencies` | 否 | 依赖的插件 id,安装时须已存在,激活时须已激活 |
| `conflicts` | 否 | 冲突的插件 id,同时安装会被拒绝 |
| `capabilities` | 是 | 申请的能力,不得重复 |
| `mounts` | 否 | 订阅的挂载点,可选值为 `session:changed` 与 `chat:before-request` |

改清单时的注意事项:

- `id` 全局唯一,重复安装会被拒绝。
- `version` 是插件版本,与 `package.json` 中的版本无关。
- `capabilities` 只写能力表内的名字,未知或重复的能力会让安装被拒绝。
- `conflicts` 当前写 `dsc-llm-tune`,与对侧清单里的 `dsc-humanize` 互为对应;只改一侧等于没有互斥。
- 契约以 DeepSeek-Chat-Enhanced 源码为准;`src/types.ts` 只覆盖本插件用到的字段,缺的字段请查源码。
- 字段与校验规则的完整说明见 [specs/plugin-develop-spec.md](specs/plugin-develop-spec.md),可用 `node scripts/validate-specs.mjs <清单文件>` 校验。

## 与 dsc-llm-tune 互斥

本插件与 dsc-llm-tune 互斥:两者都改写请求参数,不能同时启用。

| 项 | 内容 |
|:---:|:---:|
| 互斥原因 | 两者都改写同一次请求的采样参数,补丁按登记顺序合并,标量以后登记者为准,用户无法预测最终取值 |
| 职责分工 | 本插件提供预设(改什么由资产决定);dsc-llm-tune 提供自由调节(每个参数由用户直接设定) |
| 本插件一侧 | [src/manifest.ts](src/manifest.ts) 的 `conflicts: ['dsc-llm-tune']` |
| 另一侧 | dsc-llm-tune 的清单声明 `conflicts: ['dsc-humanize']`,由该仓库负责 |
| 宿主行为 | 两个插件同时安装会被拒绝(按清单的 `conflicts` 判定) |

职责互补但不并存:需要成型的助手形态时用本插件,需要精确控制采样参数时用 dsc-llm-tune,按需切换而不是同时安装。生效的只有清单里的 `conflicts`;上文「meta.json 生成规则」里的同名字段只用于与清单保持一致,宿主由 `meta.json` 推导清单时并不读它。

## 能力清单

| 能力 | 上下文成员 | 限流 |
|:---:|:---:|:---:|
| `sessions:list` | `context.sessions.list` | 30 次 / 10 秒 |
| `sessions:read` | `context.sessions.read` | 30 次 / 10 秒 |
| `sessions:rename` | `context.sessions.rename` | 5 次 / 10 秒 |
| `events:session` | `context.events.on` | 5 次 / 10 秒 |
| `notify` | `context.ui.notify` | 10 次 / 10 秒 |
| `settings:locale` | `context.settings.locale` | 60 次 / 10 秒 |
| `plugins:storage` | `context.storage` | 100 次 / 10 秒,单插件 64KB |
| `chat:request` | `context.chat.onBeforeRequest` | 10 次 / 10 秒(仅登记) |

`net:fetch` 仅内置插件可申请,第三方插件在清单里写它会被拒绝。

本插件当前申请 `events:session`、`notify`、`plugins:storage` 与 `chat:request` 四项能力,声明 `session:changed` 与 `chat:before-request` 两个挂载点;其中 `plugins:storage` 用于一次性迁移插件存储里的过渡快照(迁出后不再使用),不申请用不到的能力。

## 发布

- 交付 `dist/` 整个目录,不要只交付 `plugin.js`:`meta.json` 是市场识别插件的依据,`MUST_PLUSH_WITH_PACKAGE` 表明该目录必须随包分发。
- 目录结构、`meta.json` 的字段名与 `.author.sig` 的命名都不要改动,市场与合集按约定解析。
- 需要作者签名时,连同 `plugin.js.author.sig` 与 `author_pub.pem` 一起交付,并把公钥交给插件合集放到 `plugins/<作者>/author_pub.pem`。
- 产物托管在支持 `https` 的静态站点或 CDN 上,保持地址稳定;地址失效会影响检查更新与重新安装,已安装插件的启动恢复只用安装时保存的代码。
- 发布前在浏览器控制台执行一次 `import('https://你的地址/plugin.js')`,确认没有语法错误与缺失依赖。
- `dist/` 已被 `.gitignore` 忽略,需要交付产物时在 Release 中附带。
- 插件运行在用户浏览器中,可以读取当前会话的可见字段,不能读取 API Key、附件原件与其他插件的数据;分发时必须提示用户只安装信任来源的插件。
- [README.user.md](README.user.md) 是面向普通用户的说明文档,功能变化时同步更新。

## 常见问题

### 产物多出或少了一个文件

构建脚本会清空 `dist/` 并校验产物清单,只允许 `meta.json`、`plugin.js`、`MUST_PLUSH_WITH_PACKAGE`,以及启用作者签名时的 `plugin.js.author.sig` 与 `author_pub.pem`。出现其他文件说明源码用了动态 `import()` 或引入了需要单独输出的资源。

### meta.json 校验失败

构建脚本按 `schemas/runtime/meta.json` 的规则自校验,报错会指出具体字段。常见原因是 `package.json` 的 `name` 不匹配 `dsc-xxx`、`version` 不是三段数字、`dsc` 块缺少 `engines` 或 `repo_link`,或 `author` 写成了对象。

### 签名没有产出

`AUTHOR_SIGN_ENABLE` 只认 `true`(忽略大小写与首尾空格),写成 `1`、`yes` 等取值都会视为关闭。启用后如果 `AUTHOR_SIGN_PRIVATE_KEY` 缺失、不是 PKCS#8 PEM,或不是 Ed25519 私钥,构建会直接失败并打印原因。

签名产出后验签不通过,通常是签名与交付之间的文件被重新保存过:CRLF 与 LF 的差别就足以让验签失败。

### 清单缺失

安装结果为 `invalid-manifest`,宿主提示 `pluginManifestMissing`,通常是产物没有导出 `manifest`。确认 [src/index.ts](src/index.ts) 保留了 `export { manifest } from './manifest.js'`,并且 `build.mjs` 的入口仍是 `src/index.ts`。

### 版本不兼容

安装结果为 `incompatible-version`,说明 `engines` 与宿主 dsc-core 版本不匹配。本插件清单声明 `^1.0.0`;宿主主版本变化时按需调整 `engines`。

### 从地址安装失败

先确认产物地址本身可访问:在新标签页直接打开该地址,应当返回脚本内容而不是 404、错误页或登录跳转。再确认 CORS:宿主用 `fetch` 取产物字节,跨源托管必须返回 `Access-Control-Allow-Origin`;缺少该响应头时浏览器会在控制台报 CORS 错误,安装结果是 `artifact-unreachable`。把产物与页面放在同一域名下同源部署可以避开这一限制。

## 许可证

[Apache-2.0](LICENSE)。