# dsc-humanize

English | [简体中文](README.md)

dsc-humanize is a dsc plugin that aims to bring the assistant in ds-chat closer to what you expect. The plugin does not promise to turn the assistant into one fixed shape: what the assistant is like is what you enter and edit in the plugin UI.

Within this positioning, the plugin's job is complete editing of humanize assets: the properties settable in the UI cover every item of an asset, editing results can be exported one-to-one as a standard `dsc-humanize-asset` package, and packages in that format can be imported one-to-one, so no property is beyond the user's reach. `dsc-humanize-inner-asset` only provides importable preset asset packages, one source among several; it does not change the plugin's positioning.

The engineering structure follows dsc-plugin-template: sources written in TypeScript, bundled by esbuild into a single browser ESM file; the build also produces the runtime metadata and optionally an author signature for `plugin.js`, and the artifacts can be installed from a URL directly in DeepSeek-Chat-Enhanced.

The current implementation scope (wired modules, their status and boundaries) is described in [docs/dev/implementation-status.md](docs/dev/implementation-status.md); mechanisms, design decisions and trade-offs live in the design documents under [docs/design/](docs/design/); the guide for end users is [README.user.md](README.user.md). Except for this file, the repository's documents are maintained in Chinese.

## Requirements

| Item | Requirement |
|:---:|:---:|
| Node.js | 18 or later; 22.18 or later to run the tests |
| pnpm | 12 or later |
| OpenSSL | 3.0 or later, needed only when author signing is enabled |
| Target browsers for the artifacts | Chrome 105, Edge 105, Safari 16, Firefox 110 |

pnpm 12 does not run dependency install scripts by default; `pnpm-workspace.yaml` explicitly allows esbuild's build script via `allowBuilds`. Do not delete that file.

## Quick start

```bash
git clone https://github.com/omds-chat/dsc-humanize.git
cd dsc-humanize
pnpm install
pnpm run type
pnpm run build
pnpm run test
```

| Command | Purpose |
|:---:|:---:|
| `pnpm install` | Install dev dependencies |
| `pnpm run type` | Run `tsc --noEmit` for type checking |
| `pnpm run build` | Build all artifacts |
| `pnpm run validate:specs` | Validate the spec area: schemas, examples and this repo's meta data |
| `pnpm run test` | Run the kernel tests under `node --test` |

Tests use Node's built-in `node:test`, dependency-free and offline-capable; they load the TypeScript sources under `src` directly, which requires Node 22.18 or later (built-in type stripping). Run `pnpm run test` after changing the kernel.

## Documentation

The documents linked below are maintained in Chinese; this file is the English counterpart of `README.md`.

| Document | Responsibility |
|:---:|:---:|
| [docs/README.md](docs/README.md) | Documentation index: one-line responsibility per document, precedence, layering and upkeep rules |
| [README.user.md](README.user.md) | End-user guide: install, usage and privacy boundaries |
| [docs/design/kernel-and-assets.md](docs/design/kernel-and-assets.md) | Finalized design of the kernel and assets |
| [docs/design/kernel-and-assets-open-questions.md](docs/design/kernel-and-assets-open-questions.md) | Open questions of the kernel and assets |
| [docs/design/asset-market.md](docs/design/asset-market.md) | Finalized design of the asset market |
| [docs/dev/implementation-status.md](docs/dev/implementation-status.md) | Implementation status: wired modules, status and boundaries |
| [docs/dev/engineering-handbook.md](docs/dev/engineering-handbook.md) | Engineering handbook: artifacts, meta.json, author signing, manifest, capabilities, release and FAQ |
| [docs/dev/source-tree.md](docs/dev/source-tree.md) | Source tree and per-file responsibilities |
| [specs/README.md](specs/README.md) | Specs index: runtime spec, development spec and schemas |

## Repository layout

```text
dsc-humanize/
├── README.md                 # developer entry (Chinese); this file is its English counterpart
├── README.en-US.md           # English version, kept in sync with README.md
├── README.user.md            # end-user guide
├── build.mjs                 # build entry
├── package.json              # project info, source of meta.json
├── pnpm-workspace.yaml       # allows esbuild's install script
├── tsconfig.json
├── certs/                    # public asset-side certificates: root CA and per-source EEC certificates
├── docs/                     # design docs, engineering handbook and doc index
├── schemas/                  # manifest and runtime meta JSON schemas with examples
├── scripts/                  # build helpers, spec validation and tests
├── specs/                    # runtime spec, development spec and version info
└── src/                      # plugin sources; see docs/dev/source-tree.md
```

`.env.example` is the environment variable template for local integration addresses and author signing; copy it to `.env` to take effect, and `.env` never enters git.

## License

[Apache-2.0](LICENSE).