# dsc-humanize

[简体中文] | [English](README.en-US.md)

dsc-humanize 是一个 dsc 插件,目的是让 ds-chat 里的助手更接近你期望的样子。插件本身不承诺把助手变成某种固定形态:助手该是什么样子,由你在插件界面里输入与编辑。

在这个定位下,插件要做的是对人性化资产的完整编辑能力:界面里能设置的属性覆盖资产的每一项,编辑结果可以一比一导出为标准 `dsc-humanize-asset` 资产包,也能把该格式的资产包一比一导入,因此不存在用户无法设置的属性。`dsc-humanize-inner-asset` 只提供可导入的预设资产包,是资产来源之一,不改变插件本身的定位。

工程结构沿用 dsc-plugin-template:用 TypeScript 写源码,用 esbuild 打包成单个浏览器 ESM 文件;构建同时产出运行时元数据,可选地为 `plugin.js` 产出作者签名,产物可以直接在 DeepSeek-Chat-Enhanced 中从地址安装。

当前实现范围(已接入的模块、各自的状态与边界)见 [docs/dev/implementation-status.md](docs/dev/implementation-status.md);机制、设计与取舍理由见 [docs/design/](docs/design/) 下的设计文档;面向普通使用者的说明见 [README.user.md](README.user.md)。

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

## 文档

| 文档 | 职责 |
|:---:|:---:|
| [docs/README.md](docs/README.md) | 文档索引:每份文档的职责一句话、冲突时以谁为准、分层与维护约定 |
| [README.user.md](README.user.md) | 面向插件使用者的说明:安装、使用与隐私边界 |
| [docs/design/kernel-and-assets.md](docs/design/kernel-and-assets.md) | 内核与资产的设计定稿 |
| [docs/design/kernel-and-assets-open-questions.md](docs/design/kernel-and-assets-open-questions.md) | 内核与资产的未定稿与待定项 |
| [docs/design/asset-market.md](docs/design/asset-market.md) | 资产市场的设计定稿 |
| [docs/dev/implementation-status.md](docs/dev/implementation-status.md) | 实现现状:已接入模块、状态与边界 |
| [docs/dev/engineering-handbook.md](docs/dev/engineering-handbook.md) | 工程手册:构建产物、meta.json、作者签名、清单、能力、发布与常见问题 |
| [docs/dev/source-tree.md](docs/dev/source-tree.md) | 源码目录结构与逐文件职责 |
| [specs/README.md](specs/README.md) | 规范区索引:运行时规范、开发规范与 Schema |

## 目录结构

```text
dsc-humanize/
├── README.md                 # 开发者入口(本文件)
├── README.en-US.md           # 英文版,与 README.md 同步维护
├── README.user.md            # 面向插件使用者的说明
├── build.mjs                 # 构建入口
├── package.json              # 工程信息,meta.json 的数据来源
├── pnpm-workspace.yaml       # 允许 esbuild 的安装脚本
├── tsconfig.json
├── certs/                    # 资产侧公开证书:根证书与各来源 EEC 证书
├── docs/                     # 设计文档、工程手册与文档索引
├── schemas/                  # 清单与运行时 meta 的 JSON Schema 及样例
├── scripts/                  # 构建辅助、规范校验与测试
├── specs/                    # 运行时规范、开发规范与版本信息
└── src/                      # 插件源码;结构见 docs/dev/source-tree.md
```

.env.example 是本地联调地址与作者签名的环境变量模板,复制为 `.env` 后生效;`.env` 不进 git。

## 许可证

[Apache-2.0](LICENSE)。