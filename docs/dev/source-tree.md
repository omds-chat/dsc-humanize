# 源码目录结构

> 本文记录仓库的目录树与逐文件职责,面向要改源码或找文件的贡献者;构建、签名与发布的操作口径见 [engineering-handbook.md](engineering-handbook.md),实现现状见 [implementation-status.md](implementation-status.md)。

## 目录树

```text
dsc-humanize/
├── .env.example              # 环境变量模板:作者签名与本地联调地址
├── .gitattributes            # 全仓库统一 LF
├── .gitignore
├── .npmrc
├── COPYRIGHT                 # 版权声明
├── LICENSE
├── README.md                 # 开发者入口
├── README.user.md            # 面向插件使用者的说明
├── README.en-US.md           # 英文版,与 README.md 同步维护
├── build.mjs                 # 构建入口
├── package.json              # 工程信息,meta.json 的数据来源
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.json
├── certs/
│   ├── dsc-humanize/                  # 资产侧根证书与公钥
│   ├── dsc-humanize-inner-asset/      # 内置资产合集的证书与公钥
│   └── awesome-dsc-humanize-asset/    # 社区资产合集的证书与公钥
├── docs/
│   ├── README.md             # 文档索引
│   ├── design/               # 设计定稿与未定稿:kernel-and-assets、kernel-and-assets-open-questions、asset-market
│   └── dev/                  # 工程手册、实现现状与源码目录说明
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
│   │   ├── market-catalog.test.ts # 市场目录取件:两种形状、证书三档、两轴结论
│   │   ├── market-install.test.ts # 市场安装:清单逐文件、哈希、原子性与记录
│   │   ├── market-page.test.ts # 市场 slot:描述生成、动作分发、失败降级与短缓存
│   │   ├── market-sources.test.ts # 市场来源:地址判定、注入回退、设置开关
│   │   ├── market-transport.test.ts # assets:read 三态映射与通道注入
│   │   ├── rule-classifier.test.ts
│   │   ├── settings-page.test.ts # 资产来源设置页:登记、form 同源、保存后取件生效
│   │   ├── slots.test.ts      # 按钮状态、开关落盘与资产状态通知
│   │   ├── snapshot-db.test.ts # IndexedDB 快照封装
│   │   ├── strategy-engine.test.ts
│   │   └── trust-chain.test.ts # 证书链校验与导入两轴结论
│   ├── smoke-market.mjs      # 本地回环冒烟:两静态目录跑目录取件与安装
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
│   ├── market/               # 资产市场逻辑层与 slot 描述构建
│   │   ├── transport.ts      # 宿主 assets:read 三态 -> 内核 transport 的映射
│   │   ├── sources.ts        # 来源模型:内置两来源、地址判定、设置表面字段
│   │   ├── catalog.ts        # 目录取件:来源元数据、证书三档、链校验、assets.json
│   │   ├── install.ts        # 安装取件:包层清单逐文件、SHA-512 比对、扁平化
│   │   └── page.ts           # ui:slot 描述模型:目录条目、来源表单、动作键与截断收敛
│   ├── slots/                # 补充槽位的描述模型
│   │   ├── settings-page.ts  # 资产来源设置页:区块、保存记录与生效值合并
│   │   ├── rewrite-switch.ts # 人性化开关:存储键、读取口径与工具条按钮描述
│   │   └── asset-notice.ts   # 资产状态通知:登记条件、正文口径与来源可达性结论
│   └── humanize/             # 内核骨架,不接宿主
│       ├── index.ts          # 内核对外出口
│       ├── kernel.ts         # 内核装配:分类 -> 策略 -> 注入
│       ├── types.ts          # 内核公共类型
│       ├── assets/
│       │   └── loader.ts     # 资产读取适配层
│       ├── injection/
│       │   ├── builder.ts    # 提示词片段拼接
│       │   └── examples.ts   # 对比示例的注入文本渲染
│       ├── intent/
│       │   ├── lang.ts       # 语言判定分量:CJK 占比启发
│       │   ├── onnx-classifier.ts # ONNX 分类器占位,仅接口
│       │   └── rule-classifier.ts # 规则分类器,默认可用
│       └── strategy/
│           └── engine.ts     # 标签到策略的解析
```

构建产物输出到 `dist/`,该目录已被 `.gitignore` 忽略;产物清单见 [engineering-handbook.md](engineering-handbook.md) 的「构建产物」一节。

## 文件职责

| 文件 | 作用 |
|:---:|:---:|
| `build.mjs` | 构建入口:打包、生成 `meta.json`、自校验、可选作者签名 |
| `package.json` | 工程信息与 `meta.json` 的数据来源 |
| `src/index.ts` | 激活与停用入口,快照装配与资产包导入 |
| `src/manifest.ts` | 插件运行时清单,产物继续导出 |
| `src/host/` | 宿主请求接线与资产交付:申请 `chat:request` 把内核结果映射成宿主补丁;读取当前使用快照 |
| `src/market/` | 资产市场逻辑层与 slot 描述构建:assets:read 三态映射、来源模型、目录取件、安装取件与 ui:slot 描述构建 |
| `src/slots/` | 补充槽位的描述模型:资产来源设置页(区块、保存记录、生效值合并与表单字段回填)、人性化开关(存储键、读取口径、按钮文案与气泡参数)与资产状态通知(登记条件、正文口径、资产包可用性判断) |
| `src/trust/` | 内嵌的资产根证书常量与来源证书链校验:零依赖 DER 解析、WebCrypto 验签与导入两轴结论 |
| `src/humanize/` | 内核骨架:意图分类、策略引擎、注入构建与资产加载,不读写宿主 |
| `certs/` | 资产侧公开证书:资产根证书与两个资产合集的 EEC 证书及公钥,构建期内嵌根证书 |
| `docs/` | 文档:索引([README.md](../README.md))、设计定稿与未定稿(design/)、工程手册与实现现状(dev/) |
| `schemas/manifest/` | 清单 JSON Schema,与宿主的清单校验规则对齐 |
| `schemas/runtime/` | 运行时 meta 的 JSON Schema,构建自校验覆盖其中的必填与格式规则 |
| `scripts/validate-specs.mjs` | 零依赖校验脚本,校验 Schema、样例与本仓库 meta |
| `scripts/test/` | 测试:分类打分与排序、策略校验与合并、注入拼接、资产按类型读取与校验、快照装配与资产包导入、证书链校验、内核装配、宿主请求前接线、四处槽位的接线(含资产来源设置页的登记、保存与取件) |
| `specs/` | 规范区:运行时规范、开发规范与版本信息 |
| `.env.example` | 环境变量模板 |