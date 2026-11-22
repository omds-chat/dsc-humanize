# dsc 插件规范区

本目录与 [schemas/](../schemas/runtime/meta.json) 一起收拢 dsc 插件的运行时规范、开发规范、JSON Schema。规范内容来自 DeepSeek-Chat-Enhanced 的 `dsc-plugin-engine` 实现与其开发文档,内容随本仓库从 dsc-plugin-template 复制保留,本仓库只做收拢、机器可校验化与本地校验,不新增规则。

## 内容

| 文件 | 内容 |
|:---:|:---:|
| [plugin-runtime-spec.md](plugin-runtime-spec.md) | 运行时规范:产物形态与体积上限、导出契约、生命周期与超时、能力与限流、上下文成员(可见范围、事件、提示与设置、插件数据、大体积数据与 IndexedDB、联网与外源请求、资产读取与下载、请求前补丁、插件设置表面、UI 槽位、供应端点与按端点执行)、安全边界、错误降级 |
| [plugin-develop-spec.md](plugin-develop-spec.md) | 开发规范:清单字段与校验、UI 槽位白名单、资产声明块、版本与依赖、运行时 meta、作者签名与公钥位置、分发要求 |
| [spec-version.json](spec-version.json) | 规范版本与 Schema 路径,供其他仓库引用时锁定 |
| [../schemas/manifest/plugin-manifest.schema.json](../schemas/manifest/plugin-manifest.schema.json) | 清单 Schema |
| [../schemas/runtime/meta.json](../schemas/runtime/meta.json) | 运行时 meta Schema |
| [../schemas/examples/manifest.valid.json](../schemas/examples/manifest.valid.json) | Schema 的通过样例与反例 |
| [../scripts/validate-specs.mjs](../scripts/validate-specs.mjs) | 零依赖校验脚本 |

## 权威来源与引用约定

- 权威来源是 `dsc-plugin-engine` 的实现:清单校验、能力表、限流、加载与签名都以实现为准;实现与文档不一致时以实现为准,并在「已知差异」里保留两侧口径。
- 其他仓库引用该规范时,按 dsc-plugin-template 的 `spec_version` 选定版本,再用 git 标签或提交固定,不要在文档里引用浮动分支;Schema 路径以 [spec-version.json](spec-version.json) 的 `schemas` 字段为准。
- 上游实现变更后,先在上游仓库改规范与 Schema,再升 `spec_version`,最后同步引用方与本仓库的副本;`dsc_core` 字段记录对应的宿主版本。

## 校验

```bash
node scripts/validate-specs.mjs                          # 自检 Schema、样例与本仓库 meta 数据
node scripts/validate-specs.mjs <清单文件>                # 校验单个清单
node scripts/validate-specs.mjs <meta.json> --schema meta # 校验单个运行时 meta
```

脚本只用 Node 内置模块,不联网、不安装依赖。自检覆盖:规范版本与 Schema 路径一致、Schema 结构可用、正例通过、反例被拒绝、`package.json` 派生的 meta 通过运行时 meta Schema。若磁盘上存在构建产出的 `meta.json`,也会一并校验。

## 已知差异

本仓的规范正文与 Schema 已和 dsc-plugin-template 的 spec_version 1.1.0 逐字一致,规范与模板之间没有正文差异,旧版按「上游文档 vs 实现」留痕的条目已随上游文档与规范正文更新全部收敛,不再保留。下表只记录本仓相对上游模板真实存在的本地差异,每行给出上游文件与行号,不修改上游文档:

| 主题 | 上游(dsc-plugin-template)口径 | 本仓口径 | 上游位置 |
|:---:|:---:|:---:|:---:|
| 样例收录范围 | `schemas/examples/` 另有 `meta.full.valid.json` 正例;`schemas/examples/invalid/` 另有 `manifest.unknown-mount.json`、`meta.bad-conflicts.json`、`meta.duplicate-mount.json`、`meta.unknown-capability.json`、`meta.unknown-mount.json` 五个反例 | 本仓按需收录,样例集是上游的子集;已收录的每个样例文件与上游逐字一致 | dsc-plugin-template 的 `schemas/examples/` 与 `schemas/examples/invalid/` |
| 校验脚本的 meta 推导 | `scripts/validate-specs.mjs` 从 `package.json` 的 `dsc` 块派生 meta 时,把 `capabilities`、`mounts`、`conflicts` 三项原样搬运,没写就不产出 | 本仓同名脚本只搬运 `conflicts`,不搬 `capabilities` 与 `mounts`;本仓 `package.json` 的 `dsc` 块未声明这两项,自检结果不受影响 | dsc-plugin-template 的 `scripts/validate-specs.mjs:377-382` |

## 语言

规范正文以中文维护,与上游文档语言一致;仓库根目录的 `README.md` 与 `README.en-US.md` 保持中英两版同步。
