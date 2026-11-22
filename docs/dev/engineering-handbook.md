# 工程手册

> 本文收拢构建产物、meta.json 生成、作者签名、本地安装与联调、清单字段、能力与限流、发布与常见问题的操作口径,面向要构建、发布或改清单的贡献者。插件定位见主 README,机制与取舍见 [docs/design/](../design/) 下的设计文档,源码目录见 [source-tree.md](source-tree.md),实现现状见 [implementation-status.md](implementation-status.md)。

## 规范与 Schema

插件运行时规范、插件开发规范与配套 JSON Schema 随本仓库一并保留,用于本地校验与分发前对照;规范内容来自 dsc-plugin-template,权威实现仍是 DeepSeek-Chat-Enhanced 的 `dsc-plugin-engine`:

| 内容 | 位置 |
|:---:|:---:|
| 规范区索引与已知差异 | [specs/README.md](../../specs/README.md) |
| 插件运行时规范 | [specs/plugin-runtime-spec.md](../../specs/plugin-runtime-spec.md) |
| 插件开发规范 | [specs/plugin-develop-spec.md](../../specs/plugin-develop-spec.md) |
| 规范版本与 Schema 路径 | [specs/spec-version.json](../../specs/spec-version.json) |
| 清单 Schema | [schemas/manifest/plugin-manifest.schema.json](../../schemas/manifest/plugin-manifest.schema.json) |
| 运行时 meta Schema | [schemas/runtime/meta.json](../../schemas/runtime/meta.json) |

- 规范以 DeepSeek-Chat-Enhanced 的 `dsc-plugin-engine` 实现为准,本仓库只做收拢与机器可校验化,不新增规则;两侧口径不一致时记录在 [specs/README.md](../../specs/README.md) 的「已知差异」。
- 本仓库不对外发布规范版本;需要引用规范的其他仓库请使用 dsc-plugin-template 的 `specs/spec-version.json`,并用 git 标签或提交固定,不要引用浮动分支;改规范时先改规范与 Schema,再升版本号。
- 校验命令:`node scripts/validate-specs.mjs`(自检),`node scripts/validate-specs.mjs <清单文件>`(校验单个清单),不联网、不安装依赖。

## 构建产物

构建先清空 `dist/`,再依次产出以下产物。

| 产物 | 何时产出 | 说明 |
|:---:|:---:|:---:|
| `meta.json` | 每次构建 | 生成后立即按 `schemas/runtime/meta.json` 的规则自校验,不通过则构建失败 |
| `plugin.js` | 每次构建 | 单文件 ESM,导出 `manifest` 与 `activate` |
| `plugin.js.author.sig` | 仅启用作者签名时 | `plugin.js` 的裸公钥分离签名,64 字节二进制 |
| `author_pub.pem` | 仅启用作者签名时 | 由私钥推导出的 Ed25519 公钥,交给插件合集 |
| `MUST_PLUSH_WITH_PACKAGE` | 每次构建 | 空文件,表示该目录内容必须随包分发 |

文件名按约定原样保留,`MUST_PLUSH_WITH_PACKAGE` 的拼写不要改成 `PUSH`。

构建结束时脚本会打印每个产物的大小、压缩开关、签名状态,并检查 `dist/` 里没有预期之外的文件。文本产物(`meta.json`、`plugin.js`、`author_pub.pem`)按 LF 落盘,若检测到 CR 字节直接报错;`.author.sig` 是二进制签名,不参与换行检查。

`build.mjs` 支持 `--no-minify` 一个参数,关闭 esbuild 的行压缩。压缩后的产物体积明显更小,分发时建议保持默认压缩。

构建还会读取 [certs/dsc-humanize/dsc-humanize-root-ca.crt](../../certs/dsc-humanize/dsc-humanize-root-ca.crt),把公开根证书 PEM 注入 `plugin.js` 的常量。文件缺失或不是 PEM 证书时构建失败;产物写盘后会检查 PEM 头与证书体的一段是否真的进了 bundle,没进也失败。只内嵌公开证书,根私钥不入仓库,也不进产物。

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

启用签名时同时产出 `author_pub.pem`,它由私钥推导得到,不需要手工导出;未启用签名时不产出该文件,也不产出任何 `.author.sig`。

私钥可以写成一行,把换行写成字面量 `\n`,也可以只写私钥文件的相对路径,构建脚本会读取文件内容。

### 公钥交付

作者公钥由作者本人交给插件合集,合集按 `plugins/<作者>/author_pub.pem` 存放,用于校验该作者全部版本的 `.author.sig`。

| 交付物 | 来源 | 合集侧位置 |
|:---:|:---:|:---:|
| `author_pub.pem` | 构建产出的 `author_pub.pem` | `plugins/<作者>/author_pub.pem` |
| `plugin.js.author.sig` | 构建产出的 `plugin.js.author.sig` | 与 `plugin.js` 同目录 |

构建结束时会打印一行提示,提醒作者把 `author_pub.pem` 交给合集。

### 与合集签名的关系

作者签名与合集签名是两层独立的签名,互不替代:

| 签名 | 签名者 | 产物 | 信任来源 |
|:---:|:---:|:---:|:---:|
| 作者签名 | 插件作者 | `plugin.js.author.sig` | 作者公钥 `plugins/<作者>/author_pub.pem` |
| 合集签名 | 插件合集 | `plugin.js.sig`、各层 `manifest.json.sig` | 根 CA 签发的合集证书 `certs/<来源 id>/<来源 id>-eec.crt` |

合集签名只有两类:CMS 格式的 `plugin.js.sig`,以及每层 `manifest.json` 对应的 `manifest.json.sig`。`meta.json` 不再单独签名,它的完整性由合集的三层哈希清单校验。合集证书按 `certs/<来源 id>/<来源 id>-eec.crt` 布局存放,随合集页面分发,不参与任何清单;根目录的 `eec.pem` 只是待删除的兼容回退,新内容不要使用。CMS 签名与验签显式使用 SHA-512 摘要(`openssl cms` 加 `-md sha512`),不依赖 OpenSSL 默认值。

作者只负责产出 `.author.sig` 与 `author_pub.pem`。上述 `*.sig` 由合集在收录时用 EEC 证书生成,作者不要自己产出,也不要把 `.author.sig` 改名成 `.sig`。

## 把产物装进 DeepSeek-Chat-Enhanced

用于在本地验证构建结果:

1. 用本地静态服务器提供构建产物目录,例如 `http://localhost:8090/`。
2. 在插件面板的「从地址安装」中填入 `plugin.js` 的地址并安装;安装成功后插件自动激活,状态显示为「运行中」。
3. 打开「查看日志」可以看到 `context.log` 写入的内容,切换会话后日志会追加一条。

面向普通用户的说明见 [README.user.md](../../README.user.md)。

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
| `NPM_REGISTRY_URL` | `http://127.0.0.1:61116/` | 本地 npm registry 模拟器,只有 awesome 与 inner 合集的收录校验读取;命令行 `--registry` 与真实环境变量优先于 `.env` |
| `DSC_HUMANIZE_INNER_ASSET_PAGES_LINK` | `http://127.0.0.1:61120` | 组织预设资产合集的本地静态服务地址 |
| `AWESOME_DSC_HUMANIZE_ASSET_PAGES_LINK` | `http://127.0.0.1:61121` | 社区资产合集的本地静态服务地址 |

这些取值是本地联调用的回环地址,不是分发地址;对外分发仍按上文规则使用 `https://`。

前四个取值不写入产物:`build.mjs` 不读取它们,产物文件与 `meta.json` 都不含这些取值;三个页面地址由本仓库联调消费,npm registry 地址由合集的收录校验消费。后两个是例外:资产市场的两个内置来源按设计 2.2 由构建注入本地联调地址,`build.mjs` 把它们经 esbuild define 写进 `plugin.js`,注入值非法(非 https、非回环)时运行时退回线上地址;不配置这两行则始终走线上地址。`.env` 已被 `.gitignore` 忽略,不会进 git;`.env.example` 随仓库提交,只放示例取值。

## 如何改 manifest

清单写在 [src/manifest.ts](../../src/manifest.ts),由 [src/index.ts](../../src/index.ts) 转出为具名导出,安装时以产物自带的 `manifest` 为准。

| 字段 | 必填 | 说明 |
|:---:|:---:|:---:|
| `id` | 是 | 插件标识,须匹配 `^[a-z][a-z0-9-]{2,63}$`,仓库约定以 `dsc-` 开头 |
| `name` | 是 | 展示名称,不得为空 |
| `version` | 是 | 插件自身版本,只允许三段数字,例如 `0.1.0` |
| `engines` | 否 | 兼容的 dsc-core 版本范围,支持 `^`、`~`、`>=`、`<=` 与精确版本 |
| `dependencies` | 否 | 依赖的插件 id,安装时须已存在,激活时须已激活 |
| `conflicts` | 否 | 冲突的插件 id,同时安装会被拒绝 |
| `capabilities` | 是 | 申请的能力,不得重复 |
| `mounts` | 否 | 订阅的挂载点,可选值为 `session:changed`、`chat:before-request`、`ui:slot-action` 与 `ui:slot-data` |

改清单时的注意事项:

- `id` 全局唯一,重复安装会被拒绝。
- `version` 是插件版本,与 `package.json` 中的版本无关。
- `capabilities` 只写能力表内的名字,未知或重复的能力会让安装被拒绝。
- `conflicts` 当前写 `dsc-llm-tune`,与对侧清单里的 `dsc-humanize` 互为对应;只改一侧等于没有互斥。
- 登记 `ui:slot` 槽位时,在 `capabilities` 申请 `ui:slot`,在 `mounts` 声明 `ui:slot-action` 与 `ui:slot-data`,并在 `slots` 白名单列出槽位名。
- 契约以 DeepSeek-Chat-Enhanced 源码为准;`src/types.ts` 只覆盖本插件用到的字段,缺的字段请查源码。
- 字段与校验规则的完整说明见 [specs/plugin-develop-spec.md](../../specs/plugin-develop-spec.md),可用 `node scripts/validate-specs.mjs <清单文件>` 校验。

## 与 dsc-llm-tune 互斥

本插件与 dsc-llm-tune 互斥:两者都改写请求参数,不能同时启用。

| 项 | 内容 |
|:---:|:---:|
| 互斥原因 | 两者都改写同一次请求的采样参数,补丁按登记顺序合并,标量以后登记者为准,用户无法预测最终取值 |
| 职责分工 | 本插件提供预设(改什么由资产决定);dsc-llm-tune 提供自由调节(每个参数由用户直接设定) |
| 本插件一侧 | [src/manifest.ts](../../src/manifest.ts) 的 `conflicts: ['dsc-llm-tune']` |
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
| `settings:locale` | `context.settings.locale` | 60 次 / 10 秒 |
| `settings:surface` | `context.settings.register`、`context.settings.values` | 60 次 / 10 秒(仅登记与只读) |
| `assets:read` | `context.assets.readText` | 20 次 / 10 秒 |
| `plugins:storage` | `context.storage` | 100 次 / 10 秒,单插件 64KB |
| `chat:request` | `context.chat.onBeforeRequest` | 10 次 / 10 秒(仅登记) |
| `ui:slot` | `context.ui.registerSlot`、`context.ui.onSlotAction`、`context.ui.onSlotData` | 20 次 / 10 秒(按登记次数计) |

`net:fetch` 仅内置插件可申请,第三方插件在清单里写它会被拒绝。`assets:read` 对全部插件开放:只 GET、只 https 与回环 http、不带凭证、上限 512KB、超时 10 秒,结果三态(内容 / 状态码 / 无状态码)原样返回;本插件的资产市场只经这条通道取件,不自行发请求。

本插件当前申请 `events:session`、`notify`、`plugins:storage`、`chat:request`、`assets:read`、`settings:locale`、`settings:surface` 与 `ui:slot` 八项能力,声明 `session:changed`、`chat:before-request`、`ui:slot-action` 与 `ui:slot-data` 四个挂载点,并在 `slots` 白名单里声明 `conversation.tabs`、`settings.page`、`composer.toolbar` 与 `overlay.notice` 四个槽位;`plugins:storage` 用于一次性迁移插件存储里的过渡快照并存放人性化开关,`assets:read` 是资产市场的远端取件通道,`settings:locale` 读取宿主语言以选择界面文案,`settings:surface` 登记来源开关与自建来源字段(同一份字段也被资产来源设置页复用,两个表面读到的是同一份生效值);`ui:slot` 与两个 slot 挂载点把「资产市场」登记为会话视图标签栏里的一个标签、把「资产来源」登记为设置里的一个插件页、把「人性化」登记为工具条按钮、把资产状态登记为通知卡片(见上文「资产市场」与「界面槽位」两节)。

引擎侧对 `ui:slot` 的登记按次数计限流(20 次 / 10 秒,含 `registerSlot`、`onSlotAction` 与 `onSlotData`):本插件激活时走八次登记:三份槽位描述(资产市场标签、资产来源设置页与人性化按钮,资产状态通知按需登记)、三份动作回调(每个已用槽位各一份,引擎按插件只保留最后一份,载荷带 `slot` 分流)与两份数据处理器登记(市场标签与设置页,引擎同样只保留最后一份);切换开关时再加一次 `registerSlot`(同 id 替换),远在预算之内。

## 发布

- 交付 `dist/` 整个目录,不要只交付 `plugin.js`:`meta.json` 是市场识别插件的依据,`MUST_PLUSH_WITH_PACKAGE` 表明该目录必须随包分发。
- 目录结构、`meta.json` 的字段名与 `.author.sig` 的命名都不要改动,市场与合集按约定解析。
- 需要作者签名时,连同 `plugin.js.author.sig` 与 `author_pub.pem` 一起交付,并把公钥交给插件合集放到 `plugins/<作者>/author_pub.pem`。
- 产物托管在支持 `https` 的静态站点或 CDN 上,保持地址稳定;地址失效会影响检查更新与重新安装,已安装插件的启动恢复只用安装时保存的代码。
- 发布前在浏览器控制台执行一次 `import('https://你的地址/plugin.js')`,确认没有语法错误与缺失依赖。
- `dist/` 已被 `.gitignore` 忽略,需要交付产物时在 Release 中附带。
- 插件运行在用户浏览器中,可以读取当前会话的可见字段,不能读取 API Key、附件原件与其他插件的数据;分发时必须提示用户只安装信任来源的插件。
- [README.user.md](../../README.user.md) 是面向普通用户的说明文档,功能变化时同步更新。

## 常见问题

### 产物多出或少了一个文件

构建脚本会清空 `dist/` 并校验产物清单,只允许 `meta.json`、`plugin.js`、`MUST_PLUSH_WITH_PACKAGE`,以及启用作者签名时的 `plugin.js.author.sig` 与 `author_pub.pem`。出现其他文件说明源码用了动态 `import()` 或引入了需要单独输出的资源。

### meta.json 校验失败

构建脚本按 `schemas/runtime/meta.json` 的规则自校验,报错会指出具体字段。常见原因是 `package.json` 的 `name` 不匹配 `dsc-xxx`、`version` 不是三段数字、`dsc` 块缺少 `engines` 或 `repo_link`,或 `author` 写成了对象。

### 签名没有产出

`AUTHOR_SIGN_ENABLE` 只认 `true`(忽略大小写与首尾空格),写成 `1`、`yes` 等取值都会视为关闭。启用后如果 `AUTHOR_SIGN_PRIVATE_KEY` 缺失、不是 PKCS#8 PEM,或不是 Ed25519 私钥,构建会直接失败并打印原因。

签名产出后验签不通过,通常是签名与交付之间的文件被重新保存过:CRLF 与 LF 的差别就足以让验签失败。

### 清单缺失

安装结果为 `invalid-manifest`,宿主提示 `pluginManifestMissing`,通常是产物没有导出 `manifest`。确认 [src/index.ts](../../src/index.ts) 保留了 `export { manifest } from './manifest.js'`,并且 `build.mjs` 的入口仍是 `src/index.ts`。

### 版本不兼容

安装结果为 `incompatible-version`,说明 `engines` 与宿主 dsc-core 版本不匹配。本插件清单声明 `^1.0.0`;宿主主版本变化时按需调整 `engines`。

### 从地址安装失败

先确认产物地址本身可访问:在新标签页直接打开该地址,应当返回脚本内容而不是 404、错误页或登录跳转。再确认 CORS:宿主用 `fetch` 取产物字节,跨源托管必须返回 `Access-Control-Allow-Origin`;缺少该响应头时浏览器会在控制台报 CORS 错误,安装结果是 `artifact-unreachable`。把产物与页面放在同一域名下同源部署可以避开这一限制。