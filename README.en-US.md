# dsc-humanize

[简体中文](README.md) | [English]

dsc-humanize is a dsc plugin whose aim is to bring the assistant in ds-chat closer to what you expect. The plugin itself does not promise to turn the assistant into one fixed form: what the assistant should be like is what you enter and edit in the plugin interface.

Under that positioning the plugin's job is full editing of humanization assets: the attributes you can set in the interface cover every attribute of the asset, an edit round-trips one-to-one into a standard `dsc-humanize-asset` bundle and a bundle of that format imports back one-to-one, so there is no attribute a user cannot set. `dsc-humanize-inner-asset` only provides importable preset bundles; it is one asset source and does not change the plugin's positioning.

The project skeleton comes from dsc-plugin-template: source in TypeScript, bundled by esbuild into a single browser ESM file; the build also writes the runtime metadata, optionally signs `plugin.js`, and the output can be installed into DeepSeek-Chat-Enhanced by URL.

## Repository state

- the project skeleton copied from dsc-plugin-template: manifest, activate, deactivate
- a local copy of the contract types, so type hints work without the DeepSeek-Chat-Enhanced source tree
- a build that bundles `plugin.js`, generates and self-validates `meta.json`, and writes the `MUST_PLUSH_WITH_PACKAGE` marker
- an optional author signing step that writes `plugin.js.author.sig` with openssl
- LF line endings on every text output, with minification on by default
- a set of checkable specs: the runtime spec, the development spec and their JSON Schemas, kept in this repository for local validation
- a kernel skeleton: intent classification that outputs a (lang, shape) tuple (label hits plus a language component, with exclude keywords and anchored patterns), dimension-based injection synthesis in the strategy resolution (same dimension overrides, cross-dimension concatenation, language belongs to lang), prompt injection assembly with contrast examples, and an adapter that reads the five content types, depending on neither a model nor a host capability
- a host request hook: applies for the `chat:request` capability and declares the `chat:before-request` mount point, mapping the kernel's strategy and injection result onto a host patch
- a local asset delivery path: activation reads the active-usage snapshot from IndexedDB and assembles it, migrating the interim snapshot from plugin storage once, and `importAssetPackage` imports an asset package document from JSON text; the in-database conventions follow the initial implementation in design doc 4.6 and are marked adjustable
- a root certificate embedding and chain verification path: the build reads `certs/dsc-humanize/dsc-humanize-root-ca.crt` and injects the PEM as an artifact constant, exported at runtime as `EMBEDDED_ROOT_CA_PEM`; when `importAssetPackage` is given a source certificate it first verifies the two-level root-to-EEC chain and reports the two-axis verdict (signature verdict plus source verdict), degrading the source verdict without blocking the import
- an asset market logic layer (per [docs/design/asset-market.md](docs/design/asset-market.md)): the manifest requests `assets:read` and `settings:surface`; activation wraps `context.assets.readText` into the kernel transport injection (three-state passthrough: content means the fetch succeeded, status degrades by the 3.x rules, no-status and transport rejections map to transport-failed; without the capability or without an assets member the transport-missing status quo is kept and local assets are unaffected); two built-in sources (the organization preset and the community collection, base_url order per design 2.2, local integration addresses injected by the build and falling back to the production addresses when invalid); the source switches and one custom source (URL and collection id as a pair) are stored through settings-surface fields; the catalog fetch implements the catalog part of design 3.1 (source metadata, collection certificate in three tiers, chain verification against the embedded root, then assets.json), reads both collection metadata shapes compatibly (design 8.2), records the 3.4 two-axis verdicts and reuses `verifySourceTrust` for the chain; the install entry `installMarketPackage` fetches package files one by one against the package-level manifest with SHA-512 comparison, reuses the existing atomic semantics of `importAssetPackage` for whole-package validation, and records the collection id, effective base_url and version in the install record
- an asset market tab (landed with ui:slot, entry: the asset market tab in the conversation view tab bar; host slot details are governed by the engine docs): the manifest requests the `ui:slot` capability, declares `conversation.tabs` in the `slots` whitelist, and declares the `ui:slot-action` and `ui:slot-data` mounts; activation registers the "asset market" entry onto `conversation.tabs` with `context.ui.registerSlot` (order 50, the title picks one side of a paired zh/en wording by the host locale), the data mount re-fetches the catalog through the existing catalog layer on every model request with a short in-memory cache (5 minutes, bypassed by "refresh catalog"), and the action mount dispatches "install" to `installMarketPackage` and turns "refresh catalog" into a refresh indication; an unavailable source collapses into a single explanatory row, hint-only without blocking; see the "Asset market" section below
- two extra landing spots (also ui:slot, declared together in the manifest `slots` whitelist): a "Humanize" switch button on `composer.toolbar` (the label carries the on / off state, a click arrives through `ui:slot-action` and flips "whether asset rewriting is enabled"; the value lives under its own storage key `dsc-humanize/rewrite/v1`, the button is re-registered under the same id to refresh, and one bubble reports the current state; while it is off the request hook returns `null` and the request goes out unchanged) and an asset state notice on `overlay.notice` (a persistent notice explaining why, registered only when the asset sources are unreachable or the asset package is unusable, and revoked once the problem is gone — never registered in a healthy state); see "Humanizing switch and asset state notice" below
- a loopback smoke script: `node --import ./scripts/test/ts-hooks.mjs scripts/smoke-market.mjs` serves two static directories on 127.0.0.1:61120 and 61121 (inner with the indexed shape and the first certificate tier, awesome with the flat shape and the second tier) and walks the full catalog, slot descriptor generation, action dispatch and install path; loopback traffic only
- a dependency-free test suite: Node `node:test` covers scoring (with exclude keywords, anchored patterns and language detection), dimension synthesis (same-dimension override, cross-dimension concatenation, defaulting to tone, the language gate), contrast example reading and injection, reading and validating assets by type, the 1.1.0 feature version gate, the IndexedDB snapshot wrapper, snapshot assembly with one-time migration, package import, certificate chain verification and the import trust verdict, kernel assembly, the request hook, the market slot descriptor and action dispatch, and the three slots' wiring (button state follows the switch, the switch lands in storage on click, the notice is registered while sources are unreachable and revoked after they recover)

The kernel lands on requests through the host before-request capability: with assets it rewrites request parameters and the system prompt, and without assets the request stays unchanged. The plugin also logs session switches and shows one install notice through a host message key.

## Host request capability wired

| Module | Location | State |
|:---:|:---:|:---:|
| Intent classification | [src/humanize/intent/rule-classifier.ts](src/humanize/intent/rule-classifier.ts) | The classifier interface and a rule implementation are usable, outputting a (lang, shape) tuple with exclude keywords first and `^...$` anchored patterns; the ONNX implementation is interface plus TODO only, with no dependency added and no model downloaded |
| Strategy engine | [src/humanize/strategy/engine.ts](src/humanize/strategy/engine.ts) | Dimension-aware label-to-strategy merging and validation are usable: injection synthesizes per dimension (defaults to tone, same dimension overrides, cross dimensions concatenate) and the language dimension follows the detected language; strategy content comes entirely from assets, the kernel ships no strategy | Label-to-strategy merging and validation work; every strategy comes from assets, the kernel ships none |
| Injection assembly | [src/humanize/injection/builder.ts](src/humanize/injection/builder.ts), [src/humanize/injection/examples.ts](src/humanize/injection/examples.ts) | Contrast examples sit between the shape dimensions and the language dimension | Pure function: joins the persona prefix, the strategy injection text and the injection-type fragments, deduplicates, and places the result |
| Asset loading | [src/humanize/assets/loader.ts](src/humanize/assets/loader.ts) | Reads the five content types by declared type with two-way consistency; judges the 1.1.0 feature gate and the major version from the declared formatVersion; local data works, URLs go through the injected transport and the kernel sends no request |
| Asset read transport | [src/market/transport.ts](src/market/transport.ts), [src/index.ts](src/index.ts) | Activation wraps the host `context.assets.readText` into the kernel transport: content passes the text through, status degrades to an unusable address by the 3.x rules, no-status and transport rejections map to transport-failed ("undecidable" is never reported as an invalid address); without an assets member the transport-missing status quo is kept and local assets are unaffected |
| Market sources | [src/market/sources.ts](src/market/sources.ts) | Two built-in sources (the collection id doubles as the certificate directory name and the verdict owner), base_url order per design 2.2, local integration addresses injected by the build and falling back when invalid; the address rules match the engine (https on any host, http on loopback only); the source switches and one custom source (URL and collection id as a pair) are stored through settings-surface fields, and the source list is re-resolved on every fetch |
| Market catalog | [src/market/catalog.ts](src/market/catalog.ts) | Implements the catalog part of design 3.1: source metadata, collection certificate in three tiers, chain verification against the embedded root (reusing `verifySourceTrust`), then assets.json; both collection metadata shapes are read compatibly (design 8.2); a missing certificate only degrades the source verdict and an unreadable index empties the catalog, neither blocks browsing; the signature verdict stays unverified this round (the collections publish no signed manifests yet), and the two verdicts never substitute for each other |
| Market install | [src/market/install.ts](src/market/install.ts), [src/index.ts](src/index.ts) | `installMarketPackage` fetches package files one by one against the package-level manifest (L3 manifest.json) with SHA-512 comparison, flattens them into a load-time package document and hands it to `importAssetPackage` for whole-package validation and atomic assembly; any fetch or validation failure rejects the whole package without landing anything; the install record carries the collection id, effective base_url, author, package id, version, type set, two-axis verdicts and manifest revision |
| Kernel assembly | [src/humanize/kernel.ts](src/humanize/kernel.ts) | Takes one source per type and wires classification, strategy and injection into one plan with source records |
| Host request hook | [src/host/request-patch.ts](src/host/request-patch.ts) | Applies for the `chat:request` capability, declares the `chat:before-request` mount point, and maps classification, strategy and injection onto a host patch; returns `null` without a label set or strategy table, or when the classifier throws |
| Asset delivery | [src/host/snapshot.ts](src/host/snapshot.ts), [src/host/snapshot-db.ts](src/host/snapshot-db.ts), [src/index.ts](src/index.ts) | Activation reads the active-usage snapshot from IndexedDB and assembles it, migrating the interim plugin-storage snapshot once; `importAssetPackage` imports an asset package document from JSON text; with no snapshot or an invalid one the content stays empty; the in-database conventions follow the initial implementation in 4.6 and are adjustable |
| Root certificate embedding | [src/trust/root-ca.ts](src/trust/root-ca.ts), [build.mjs](build.mjs) | The build reads the public root certificate and injects it as an artifact constant, exported as PEM at runtime; only the public certificate is embedded |
| Certificate chain verification | [src/trust/x509.ts](src/trust/x509.ts), [src/trust/source-verdict.ts](src/trust/source-verdict.ts) | Dependency-free DER parsing plus WebCrypto signature verification: an import that carries a source certificate first verifies the two-level root-to-EEC chain and compares the certificate subject CN with the package id, then reports the signature and source verdicts; a failing chain only degrades the source verdict and never blocks the import |
| Asset editing UI | not implemented (the import entry is usable) | The plugin has no interface entry yet, so entering, editing and exporting assets are pending; import can go through `importAssetPackage` with JSON text |
| Asset bundle format | [src/humanize/types.ts](src/humanize/types.ts) | Defined by `dsc-humanize-asset-template` (format version 1.1.0): the examples type, exclude_keywords, patterns, dimension and dimension synthesis are implemented, and 1.0.0 packages stay fully compatible; export and the editing UI are not |

- The kernel is pure computation: it returns the intent, the strategy, prompt fragments and source records, and never writes back to a request or reads host state; landing on a request belongs to the host request hook.
- The host request capability is available (`chat:request`): the manifest also declares the `chat:before-request` mount point, and activation registers a handler. The handler returns `temperature`, `topP`, `maxTokens`, `stop` and `systemPromptAppend` synchronously; numbers and text lengths are not clamped in the plugin, out-of-range values are converged by the engine against the patch limits; on timeout or a throw the whole patch is dropped and the request goes out with its original parameters.
- Exclusion with dsc-llm-tune: both rewrite the parameters of the same request, so they cannot be enabled together; the manifest declares `conflicts: ['dsc-llm-tune']` and installing both is rejected by the host. The division of labour is complementary but the two do not coexist: this plugin applies presets from assets, dsc-llm-tune lets the user tune parameters freely; see "Exclusion with dsc-llm-tune" below.
- Asset loading entry: `setActiveContents` takes the content currently in use by type, in the same shape as the kernel assembly options. On activation the plugin reads the active-usage snapshot from IndexedDB (database `dsc-humanize`, object store `snapshot`, record key `active`, shape in the initial convention of design doc 4.6) and assembles it once it validates; with no snapshot or an invalid one the content stays empty and requests are left unchanged. When IndexedDB holds no record, the interim plugin-storage snapshot (legacy key `dsc-humanize/snapshot/v1`) is migrated into IndexedDB once and the legacy key is removed; a failed migration does not block activation. `importAssetPackage` imports a load-time asset package document from JSON text, replaces the current content only after the whole package validates, and writes the snapshot back when the plugin is active and IndexedDB is available (2 MB size limit; exceeding the limit or a failed write only affects persistence, not the current assembly); the import may carry a source certificate (`sourceCertPem`), in which case the root-to-EEC chain is verified first and the two-axis verdict is returned — a failing chain only degrades the source verdict to rejected and does not block the import; the editing UI and export are still pending.
- The asset package format is now defined by `dsc-humanize-asset-template` (format version 1.1.0); the kernel reads the five content types by the content types declared in the package metadata, with the declaration and the content agreeing both ways. The 1.1.0 additions (the examples type, exclude_keywords, patterns, dimension and dimension synthesis) are implemented and judged against the declared formatVersion, so 1.0.0 packages behave exactly as before. The import entry is usable (JSON text through `importAssetPackage`), while export and the editing UI are not built yet, so the preset packages from `dsc-humanize-inner-asset` still need converting into a load-time package document before import.
- The editing UI is not implemented: the plugin has no interface entry yet, so entering, editing and one-to-one export of humanization assets are pending; import is usable, but the caller has to supply JSON text.
- Self-checks cover types, the build, the specs, the kernel pure functions and the request hook: `pnpm run type`, `pnpm run build`, `pnpm run validate:specs` and `pnpm run test`; the market path additionally has a loopback smoke: `node --import ./scripts/test/ts-hooks.mjs scripts/smoke-market.mjs`.

## Asset market

Entry path: the asset market tab in the conversation view tab bar. The tab has landed with ui:slot: the plugin only submits a description, never controls; rendering, i18n and styling all belong to the host, and the host slot details are governed by the engine docs.

| Block | Content | Behaviour |
|:---:|:---:|:---:|
| text | Two-axis verdict note and the source form wording | whether the source is trusted and whether the signature passed are two separate axes that never substitute for each other; form drafts do not persist, saving belongs to the plugin settings page |
| list "Catalog" | The packages of each enabled source: title = package id, description = author and type set, badge = source name | each item carries an "Install" action dispatched to `installMarketPackage`; completion is reported with bubble notifications, never a native dialog or a modal overlay |
| form "Sources" | The two built-in source switches plus the custom-source URL and collection id; the fields share the same source as the plugin settings page (one shared field descriptor) | draft values travel with the action payload and take effect immediately for fetching and installing in the current session, but do not persist; the two surfaces cannot drift apart |
| actions | "Refresh catalog" | returns the refresh indication so the host re-requests the model; this fetch bypasses the cache |

- Fetching and refresh: the data mount re-fetches through the existing catalog layer on every model request (source metadata → collection certificate → assets.json), and the catalog results keep a short in-memory cache of 5 minutes (aligned with the design 8.1 recommendation); repeated requests within the TTL do not fetch again, balancing the 20 calls / 10 s budget of assets:read against the 60 calls / 10 s budget of settings:surface. The model request is a synchronous callback, so the first tab entry shows "reading" placeholders and the catalog appears on the next model request or refresh indication.
- Failure degradation: when a source fails to fetch (all addresses unreachable, missing channel, unreadable index), it collapses into a single explanatory row badged "source unavailable" while the other sources keep listing — hint-only without blocking; when the catalog exceeds the host descriptor size limit (8KB), items are trimmed from the tail and a truncation notice is appended.
- Install: the action resolves the item key back to source, author and package id through the item registry and hands them to `installMarketPackage` (the same path as the settings-page source resolution; the two-axis verdicts are recomputed on every install); success and failure are both reported with bubble notifications using the paired asset-specific keys the host added — success uses `pluginAssetInstalled` (asset package {id} installed), failure uses `pluginAssetInstallFailed` (asset package {id} failed to install: {reason}), never a native dialog or a modal overlay; the old `pluginInstalled` / `pluginInstallRejected` belong to plugin installation and are no longer reused. Host requirement: the host must already provide this asset-specific pair (`notify` is write-only, so a plugin cannot look up the host dictionary and there is no fallback to the old keys); on older hosts the bubble has no text while the install itself still completes.

## Humanizing switch and asset state notice

All three slots (ui:slot) are declared once at activation; rendering, i18n and styling belong to the host. The plugin submits no controls and uses no routing, dialogs or overlays.

| Slot | Landing spot | This plugin's entry | Behaviour |
|:---:|:---:|:---:|:---:|
| `conversation.tabs` | conversation view tab bar | `asset-market` (order 50) | the asset market page, see the previous section |
| `composer.toolbar` | toolbar under the composer | `rewrite-switch` (order 50) | the "Humanize · on / off" button: a click flips "whether asset rewriting is enabled" |
| `overlay.notice` | top-right notice stack | `asset-state` (order 50, level `warning`) | registered only while the asset sources are unreachable or the asset package is unusable, explaining why |

### The humanizing button

| Item | Content |
|:---:|:---:|
| Label | `Humanize · on` / `Humanize · off` (Chinese `人性化 · 开` / `人性化 · 关`). The host `composer.toolbar` descriptor has a single label field and no separate badge slot, so the state is folded into the label: wording first, state second |
| Action | a click comes back through `ui:slot-action` with `slot` = `composer.toolbar` and `actionId` = `toggle` |
| Storage | the value lives under its own plugin-storage key `dsc-humanize/rewrite/v1`, record shape `{ version: 1, enabled }`; kept apart from the snapshot (IndexedDB, the legacy key `dsc-humanize/snapshot/v1` is migration only) and the install records (`dsc-humanize/market/v1`), so the three never disturb each other |
| Refresh | after a flip the plugin calls `registerSlot` again under the same id: the host replaces same-plugin-same-id registrations, so the button text follows; the toolbar has no page model, so no refresh indication is used |
| Bubble | one bubble per click, host wording key `pluginHumanizeRewriteToggled` with `{state}` (`on` / `off`); never a dialog or an overlay |
| Relation to requests | on (the default): the request hook rewrites requests as before; off: the hook returns `null` on its first line without even reading the asset content, so the request goes out unchanged |
| Read rules | a missing key, a wrong shape or a wrong version all fall back to the default (on), with no partial retention; a failed write is logged and still applies for the current session |

Host requirement: the host dictionary needs a key `pluginHumanizeRewriteToggled` worded like "humanizing rewrite is now {state}". Without it the host i18n fallback shows the key name itself (`notify` is write-only, so a plugin cannot look up the dictionary); the state and the rewrite behaviour are unaffected.

### The asset state notice

| Item | Content |
|:---:|:---:|
| When registered | two real problems: every enabled source failed to fetch (or the host provides no `assets:read` channel, or no source is enabled); or the currently assembled asset package is unusable (no items at all, or incomplete — missing the label set or the strategy table, so rewriting cannot take effect) |
| When revoked | once neither problem holds the registration is disposed; when the wording changes the entry is re-registered under the same id, and identical wording is not registered twice (so the `ui:slot` registration budget is not spent on refresh churn) |
| Count | exactly one entry, carrying all current reasons in one paragraph; the host merges a plugin's notices into a single card, so per-reason entries would be noise |
| Level | `warning`: the feature is temporarily unusable, the plugin itself is fine (`error` would overstate it) |
| Wording | direct text (`text`), not a host wording key: the reason carries an error code and a readable summary that a dictionary key cannot hold; clamped to the host limit of 2000 characters |
| No false alarms | "no fetch verdict yet" is not unreachable: only a real attempt that failed counts; one reachable source is enough, and per-source failures stay in the market tab's row-by-row explanation |
| Relation to requests | it only explains the reason, never changes a request or blocks an install: whether rewriting takes effect is still decided by the switch and the asset content |

## Specs and schemas

The plugin runtime spec, the plugin development spec and their JSON Schemas ship with this repository for local validation and as a reference before publishing; the content comes from dsc-plugin-template and the authority is still `dsc-plugin-engine` in DeepSeek-Chat-Enhanced:

| Content | Location |
|:---:|:---:|
| Spec area index and known differences | [specs/README.md](specs/README.md) |
| Plugin runtime spec | [specs/plugin-runtime-spec.md](specs/plugin-runtime-spec.md) |
| Plugin development spec | [specs/plugin-develop-spec.md](specs/plugin-develop-spec.md) |
| Spec version and schema paths | [specs/spec-version.json](specs/spec-version.json) |
| Manifest schema | [schemas/manifest/plugin-manifest.schema.json](schemas/manifest/plugin-manifest.schema.json) |
| Runtime meta schema | [schemas/runtime/meta.json](schemas/runtime/meta.json) |

- The specs follow the `dsc-plugin-engine` implementation in DeepSeek-Chat-Enhanced; this repository only collects them and makes them machine-checkable, it does not add rules. Where the two disagree, [specs/README.md](specs/README.md) records it under "Known differences".
- This repository does not publish a spec version of its own; consumers that need the specs should use `specs/spec-version.json` from dsc-plugin-template and pin it with a git tag or commit rather than a moving branch. Change the specs and the schemas first, then bump the version.
- Validation runs offline with no dependencies: `node scripts/validate-specs.mjs` for the self-check and `node scripts/validate-specs.mjs <manifest file>` for a single manifest.

## Project layout

```text
dsc-humanize/
├── .env.example              # environment template: signing key and integration addresses
├── .gitattributes            # repository-wide LF
├── .gitignore
├── .npmrc
├── COPYRIGHT                 # copyright notice
├── LICENSE
├── README.md                 # for developers, maintained by the plugin author
├── README.user.md            # for end users, maintained by the plugin author
├── README.en-US.md           # English version of README.md, kept in sync
├── build.mjs                 # build entry
├── package.json              # project metadata, the source of meta.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.json
├── schemas/
│   ├── examples/             # passing and failing schema samples
│   ├── manifest/
│   │   └── plugin-manifest.schema.json # manifest schema
│   └── runtime/
│       └── meta.json         # runtime meta schema
├── scripts/
│   ├── test/                 # kernel pure-function tests, run by node:test
│   │   ├── ts-hooks.mjs      # resolve hook so the tests load .ts source directly
│   │   ├── asset-delivery.test.ts # snapshot assembly, one-time migration and package import
│   │   ├── asset-loader.test.ts
│   │   ├── fake-idb.ts        # fake IndexedDB test double
│   │   ├── host-wiring.test.ts # request hook wiring
│   │   ├── injection-builder.test.ts
│   │   ├── kernel.test.ts
│   │   ├── rule-classifier.test.ts
│   │   ├── slots.test.ts      # the three slots: button state, switch persistence and the asset state notice
│   │   ├── snapshot-db.test.ts # IndexedDB snapshot wrapper
│   │   ├── strategy-engine.test.ts
│   │   └── trust-chain.test.ts # certificate chain verification and the import trust verdict
│   └── validate-specs.mjs    # dependency-free spec validator
├── specs/
│   ├── README.md             # spec area index and known differences
│   ├── plugin-develop-spec.md # plugin development spec
│   ├── plugin-runtime-spec.md # plugin runtime spec
│   └── spec-version.json     # spec version and schema paths
├── src/
│   ├── env.d.ts              # build-time global constant declarations
│   ├── index.ts              # activation and deactivation, snapshot assembly and package import
│   ├── manifest.ts           # runtime manifest
│   ├── types.ts              # contract types
│   ├── host/
│   │   ├── request-patch.ts  # request hook: strategy and injection -> patch
│   │   ├── snapshot-db.ts    # IndexedDB wrapper for the active-usage snapshot: database, store, read and write
│   │   └── snapshot.ts       # active-usage snapshot: shape, version and validation, plus the legacy interim key
│   ├── trust/
│   │   ├── root-ca.ts        # embedded asset root certificate PEM constant
│   │   ├── x509.ts           # dependency-free X.509 parsing and WebCrypto chain verification
│   │   └── source-verdict.ts # import trust verdicts: signature verdict plus source verdict
│   ├── slots/                # descriptor models for the two extra slots
│   │   ├── rewrite-switch.ts # humanizing switch: storage key, read rules and toolbar button descriptor
│   │   └── asset-notice.ts   # asset state notice: registration conditions, wording and source reachability
│   └── humanize/             # kernel skeleton, not wired to the host
│       ├── index.ts          # kernel public surface
│       ├── kernel.ts         # kernel assembly: classify -> strategy -> inject
│       ├── types.ts          # kernel types
│       ├── assets/
│       │   └── loader.ts     # asset loading adapter
│       ├── injection/
│       │   ├── builder.ts    # prompt fragment assembly
│       │   └── examples.ts   # rendering contrast examples into injection text
│       ├── intent/
│       │   ├── lang.ts       # language component: CJK ratio heuristic
│       │   ├── onnx-classifier.ts # ONNX classifier placeholder, interface only
│       │   └── rule-classifier.ts # rule classifier, usable by default
│       └── strategy/
│           └── engine.ts     # label-to-strategy resolution
└── dist/                     # build output, ignored by .gitignore
```

| File | Role |
|:---:|:---:|
| `build.mjs` | Build entry: bundle, generate `meta.json`, self-validate, optional author signing |
| `package.json` | Project metadata and the source of `meta.json` |
| `src/index.ts` | Activation and deactivation entry points, snapshot assembly and package import |
| `src/manifest.ts` | Runtime manifest, still exported by the output |
| `src/host/` | Request hook and asset delivery: applies for `chat:request` and maps kernel results onto a host patch; reads the active-usage snapshot from IndexedDB and migrates the interim plugin-storage snapshot once |
| `src/trust/` | Embedded asset root certificate constant plus source certificate chain verification: dependency-free DER parsing, WebCrypto signature verification and the import trust verdicts |
| `src/slots/` | Descriptor models for the two extra slots: the humanizing switch (storage key, read rules, button wording and bubble params) and the asset state notice (registration conditions, wording, package-usability check) |
| `src/humanize/` | Kernel skeleton: intent classification, strategy engine, injection assembly and asset loading; it never reads or writes host state |
| `schemas/manifest/` | Manifest JSON Schema, aligned with the host manifest checks |
| `schemas/runtime/` | JSON Schema for the runtime meta; the build self-validation covers its required and format rules |
| `scripts/validate-specs.mjs` | Dependency-free validator for the schemas, samples and this repository meta |
| `scripts/test/` | Tests: scoring and ordering, strategy validation and merging, injection assembly, reading and validating assets by type, the IndexedDB snapshot wrapper, snapshot assembly and one-time migration, package import, certificate chain verification, kernel assembly, request hook wiring, and the three slots' wiring |
| `specs/` | Spec area: runtime spec, development spec, version info |
| `.env.example` | Environment template |

## Requirements

| Item | Requirement |
|:---:|:---:|
| Node.js | 18 or later; running the tests needs 22.18 or later |
| pnpm | 12 or later |
| OpenSSL | 3.0 or later, needed only when author signing is on |
| Output browsers | Chrome 105, Edge 105, Safari 16, Firefox 110 |

pnpm 12 does not run dependency install scripts by default; `pnpm-workspace.yaml` allows the esbuild build script through `allowBuilds`, so do not delete that file.

## Quick start

```bash
git clone https://github.com/omds-chat/dsc-humanize.git
cd dsc-humanize
pnpm install
pnpm run type
pnpm run build
pnpm run test
```

| Command | Role |
|:---:|:---:|
| `pnpm install` | Install dev dependencies |
| `pnpm run type` | Run `tsc --noEmit` for a type check |
| `pnpm run build` | Build every output |
| `pnpm run build -- --no-minify` | Build without minification |
| `pnpm run validate:specs` | Validate the spec schemas, samples and this repository meta |
| `pnpm run test` | Run the kernel tests through `node --test` |

The tests use the built-in `node:test`, need no dependency and run offline; they load the TypeScript source under `src` directly, so they need Node 22.18 or later (built-in type stripping). Run `pnpm run test` after changing the kernel.

`build.mjs` takes one flag, `--no-minify`, which turns esbuild minification off. The minified output is much smaller, so keep the default when distributing.

## Build output

The build clears `dist/` first, then writes:

```text
dist/
├── meta.json                  # runtime metadata, generated from package.json
├── plugin.js                  # runtime script, single-file ESM
├── plugin.js.author.sig       # detached author signature for plugin.js, only when signing is on
├── author_pub.pem             # author public key, only when signing is on, hand it to the collection
└── MUST_PLUSH_WITH_PACKAGE    # marker file, empty
```

| Output | When | Notes |
|:---:|:---:|:---:|
| `meta.json` | every build | Validated against the rules in `schemas/runtime/meta.json` right after generation; a failure stops the build |
| `plugin.js` | every build | Single-file ESM exporting `manifest` and `activate` |
| `plugin.js.author.sig` | only when signing is enabled | Detached raw-public-key signature for `plugin.js`, 64 binary bytes |
| `author_pub.pem` | only when signing is enabled | Ed25519 public key derived from the private key, handed to the collection |
| `MUST_PLUSH_WITH_PACKAGE` | every build | Empty file meaning the directory must ship with the package |

Keep the file names as they are, including the `PLUSH` spelling in `MUST_PLUSH_WITH_PACKAGE`.

At the end the build prints the size of every output, the minify switch and the signing state, and checks that `dist/` holds nothing unexpected. Text outputs (`meta.json`, `plugin.js`, `author_pub.pem`) are written as LF and a CR byte stops the build; `.author.sig` files are binary signatures and are not checked for line endings.

The build also reads [certs/dsc-humanize/dsc-humanize-root-ca.crt](certs/dsc-humanize/dsc-humanize-root-ca.crt) and injects the public root certificate PEM as a `plugin.js` constant. A missing file or a non-PEM certificate stops the build; after the artifact is written, the build checks that the PEM header and a slice of the certificate body really reached the bundle, and fails if they did not. Only the public certificate is embedded; the root private key is neither in the repository nor in the artifact.

## How meta.json is generated

`meta.json` is generated from `package.json` and is never edited by hand.

| `meta.json` field | Source | Required |
|:---:|:---:|:---:|
| `name` | `name` in `package.json` | yes |
| `version` | `version` in `package.json` | yes |
| `license` | `license` in `package.json` | yes |
| `author` | `author` in `package.json`, as a string | yes |
| `description` | `dsc.description`, at least `zh-CN` or `en-US` | yes |
| `repo_link` | `dsc.repo_link` | yes |
| `dependencies.dsc` | `dsc.engines` | yes |
| `conflicts` | `dsc.conflicts`, omitted when absent | no |
| `home_page` | `dsc.home_page`, omitted when absent | no |
| `attached` | `dsc.attached`, omitted when absent | no |

The `dsc` block in `package.json`:

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

When renaming the plugin, update `name` in `package.json`: it must match `dsc-xxx` or `@scope/dsc-xxx`, otherwise `meta.json` fails validation. When bumping the version, update `version` with three numeric segments.

## Author signing

Author signing is a detached raw-public-key signature: an Ed25519 private key signs the file bytes directly, and the signature sits next to the file with an extra `.author.sig` suffix. Key export, signing and verification all run through `openssl` subprocesses, so the build depends on no JavaScript crypto library.

The author signature covers `plugin.js` only. The collection verifies `meta.json` with a three-layer hash manifest, so there is no reason to sign it as an author: the build does not produce `meta.json.author.sig`, and the collection does not accept it.

```bash
# once: create the author key pair
openssl genpkey -algorithm ed25519 -out author_secret.pem
openssl pkey -in author_secret.pem -pubout -out author_pub.pem

cp .env.example .env
# edit .env and replace YOURS with the PKCS#8 PEM of author_secret.pem, or the relative path author_secret.pem
pnpm run build
```

`build.mjs` reads `.env` from the repository root; variables already present in the environment win, so passing them on the command line also works.

| Variable | Value | Notes |
|:---:|:---:|:---:|
| `AUTHOR_SIGN_ENABLE` | `true` | Only `true` enables signing (case and surrounding spaces are ignored), anything else counts as off |
| `AUTHOR_SIGN_PRIVATE_KEY` | PKCS#8 PEM | Ed25519 private key, or a path to a key file |

When enabled, the build writes a single signature, for `plugin.js` only, equivalent to running:

```bash
openssl pkeyutl -sign -rawin -inkey author_secret.pem -in dist/plugin.js -out dist/plugin.js.author.sig
```

Signatures cover the bytes on disk, with no line-ending normalization. After signing, the build verifies every signature with the public key it derived, and any failure stops the build:

```bash
openssl pkeyutl -verify -pubin -inkey dist/author_pub.pem -rawin -in dist/plugin.js -sigfile dist/plugin.js.author.sig
```

Signing also writes `dist/author_pub.pem`, derived from the private key, so there is no need to export it by hand. With signing off, neither that file nor any `.author.sig` is written.

The key may be written on one line with literal `\n` line breaks, or as a relative path to a key file that the build reads.

### Delivering the public key

The author hands the public key to the plugin collection, which keeps it at `plugins/<author>/author_pub.pem` and uses it to verify every `.author.sig` from that author.

| Artifact | Source | Location in the collection |
|:---:|:---:|:---:|
| `author_pub.pem` | `dist/author_pub.pem` from the build | `plugins/<author>/author_pub.pem` |
| `plugin.js.author.sig` | `dist/plugin.js.author.sig` from the build | next to `plugin.js` |

The build prints one line at the end reminding the author to hand `dist/author_pub.pem` to the collection.

### Relation to collection signatures

Author signatures and collection signatures are two independent layers, and neither replaces the other:

| Signature | Signer | Artifacts | Trust anchor |
|:---:|:---:|:---:|:---:|
| Author | plugin author | `plugin.js.author.sig` | the author key at `plugins/<author>/author_pub.pem` |
| Collection | plugin collection | `plugin.js.sig` and every layer's `manifest.json.sig` | the collection certificate `certs/<source id>/<source id>-eec.crt` issued by the root CA |

Collection signatures come in two kinds only: the CMS-formatted `plugin.js.sig`, and the `manifest.json.sig` of every layer's `manifest.json`. `meta.json` is no longer signed on its own; the collection verifies it with the three-layer hash manifest. The collection certificate lives under the `certs/<source id>/<source id>-eec.crt` layout, ships with the collection bundle and is covered by no manifest; the `eec.pem` in the root directory is only a compatibility fallback waiting for deletion and must not be used for new content.

Authors only produce `.author.sig` and `author_pub.pem`. The `*.sig` files above are generated by the collection with the EEC certificate at intake, so do not produce them yourself and do not rename `.author.sig` to `.sig`.

## Installing the output into DeepSeek-Chat-Enhanced

Use this to verify a build on your machine:

1. Serve the `dist/` directory from a local static server, for example `http://localhost:8090/`.
2. Install the `plugin.js` URL through the install-from-URL field of the plugin panel; the plugin activates right after a successful install and its status shows as running.
3. Open the plugin log to see what `context.log` wrote; every session switch appends one line.

The end-user document is [README.user.md](README.user.md).

URL rules: use an `https://` URL when distributing. For local debugging DeepSeek-Chat-Enhanced accepts `http://localhost`, `http://127.0.0.1` and `http://[::1]`; every other address must use `https://`.

The install record keeps the code text of the output, and startup restores from it without fetching again; after changing the output, uninstall the plugin in the panel and install it again so the new bytes are fetched.

Deployment requirement: the host fetches the output bytes and stores them as UTF-8 text, so the host must return an `Access-Control-Allow-Origin` header, for example `Access-Control-Allow-Origin: *`; otherwise fetching is rejected and the install fails when the output is served from a different origin. The fetch sends no credentials, so `Access-Control-Allow-Credentials` is not needed. Serving the output from the same domain as the page needs no such header.

## Local integration addresses

For offline integration across repositories, create `.env` in the repository root first:

```bash
cp .env.example .env
```

| Variable | Local value | Notes |
|:---:|:---:|:---:|
| `DS_CHAT_PAGES_LINK` | `http://127.0.0.1:61117` | Chat page address |
| `DSC_INNER_PLUGIN_PAGES_LINK` | `http://127.0.0.1:61118` | Inner-plugin page address |
| `AWESOME_DSC_PLUGIN_PAGES_LINK` | `http://127.0.0.1:61119` | Plugin collection page address |
| `DSC_HUMANIZE_INNER_ASSET_PAGES_LINK` | `http://127.0.0.1:61120` | Local static server of the organization preset asset collection |
| `AWESOME_DSC_HUMANIZE_ASSET_PAGES_LINK` | `http://127.0.0.1:61121` | Local static server of the community asset collection |

These values are local loopback addresses for integration only, not distribution addresses; distribution still uses `https://` as described above.

The first three are consumed for integration only and never enter the artifacts: `build.mjs` does not read them, and the files under `dist/` plus `meta.json` contain none of these values. The last two are the exception: the two built-in asset market sources have their local integration addresses injected by the build per design 2.2, and `build.mjs` writes them into `plugin.js` via esbuild define; an invalid injected value (not https, not loopback) falls back to the production addresses at runtime, and without these two lines the production addresses are always used. `.env` is ignored by `.gitignore` and never enters git; `.env.example` is committed with sample values only.

This repository consumes these addresses for integration only and never writes them into artifacts: `build.mjs` does not read them, and neither the files under `dist/` nor `meta.json` contain them. `.env` is already ignored by `.gitignore` and does not enter git; `.env.example` is committed and holds example values only.

## Editing the manifest

The manifest lives in [src/manifest.ts](src/manifest.ts) and is re-exported by [src/index.ts](src/index.ts). Installation uses the `manifest` exported by the output.

| Field | Required | Notes |
|:---:|:---:|:---:|
| `id` | yes | Plugin identifier, must match `^[a-z][a-z0-9-]{2,63}$`, the repository convention is a `dsc-` prefix |
| `name` | yes | Display name, must not be empty |
| `version` | yes | Plugin version, three numeric segments such as `0.1.0` |
| `engines` | no | Compatible dsc-core range, supports `^`, `~`, `>=`, `<=` and an exact version |
| `dependencies` | no | Required plugin ids, present at install time and active at activation time |
| `conflicts` | no | Conflicting plugin ids, installing both is rejected |
| `capabilities` | yes | Requested capabilities, no duplicates |
| `mounts` | no | Subscribed mount points, `session:changed` and `chat:before-request` |

Things to keep in mind:

- `id` is globally unique; a second plugin with the same id is rejected.
- `version` is the plugin version and is unrelated to the version in `package.json`.
- `capabilities` may only contain names from the capability table; unknown or duplicate entries make the install fail.
- `conflicts` currently holds `dsc-llm-tune`, matching `dsc-humanize` in the other side's manifest; changing one side only removes the exclusion.
- The DeepSeek-Chat-Enhanced source is the authority for the contract; `src/types.ts` covers only the fields this plugin uses, so check the source for anything else.
- The full field and validation rules are in [specs/plugin-develop-spec.md](specs/plugin-develop-spec.md); check a manifest with `node scripts/validate-specs.mjs <manifest file>`.

## Exclusion with dsc-llm-tune

This plugin and dsc-llm-tune exclude each other: both rewrite request parameters, so they cannot be enabled together.

| Item | Content |
|:---:|:---:|
| Why | Both rewrite the sampling parameters of the same request; patches merge in registration order, later registrations win on scalars, so the final values are not predictable for the user |
| Division of labour | This plugin applies presets (assets decide what to change); dsc-llm-tune offers free tuning (the user sets each parameter directly) |
| This side | `conflicts: ['dsc-llm-tune']` in [src/manifest.ts](src/manifest.ts) |
| Other side | dsc-llm-tune declares `conflicts: ['dsc-humanize']` in its manifest, owned by that repository |
| Host behaviour | Installing both plugins is rejected, judged from the `conflicts` field |

The two are complementary but do not coexist: use this plugin when you want a shaped assistant and dsc-llm-tune when you need precise control over sampling parameters, switching as needed instead of installing both. Only the manifest's `conflicts` takes effect; the same field in `meta.json`, described under "How meta.json is generated" above, only keeps the artifact consistent with the manifest and is not read when the host derives a manifest from `meta.json`.

## Capabilities

| Capability | Context member | Rate limit |
|:---:|:---:|:---:|
| `sessions:list` | `context.sessions.list` | 30 calls / 10 s |
| `sessions:read` | `context.sessions.read` | 30 calls / 10 s |
| `sessions:rename` | `context.sessions.rename` | 5 calls / 10 s |
| `events:session` | `context.events.on` | 5 calls / 10 s |
| `notify` | `context.ui.notify` | 10 calls / 10 s |
| `settings:locale` | `context.settings.locale` | 60 calls / 10 s |
| `settings:surface` | `context.settings.register`, `context.settings.values` | 60 calls / 10 s (registration and read-only) |
| `assets:read` | `context.assets.readText` | 20 calls / 10 s |
| `plugins:storage` | `context.storage` | 100 calls / 10 s, 64KB per plugin |
| `chat:request` | `context.chat.onBeforeRequest` | 10 calls / 10 s (registration only) |
| `ui:slot` | `context.ui.registerSlot`, `context.ui.onSlotAction`, `context.ui.onSlotData` | 20 calls / 10 s (counted per registration) |

`net:fetch` is available to built-in plugins only; a third-party manifest that requests it is rejected. `assets:read` is available to all plugins: GET only, https and loopback http only, no credentials, a 512KB body limit, a 10-second timeout, and a three-state result (content / status code / no status code) returned as is; this plugin's asset market fetches exclusively through that channel and sends no request on its own.

This plugin currently requests `events:session`, `notify`, `plugins:storage`, `chat:request`, `assets:read`, `settings:surface` and `ui:slot`, and declares `session:changed`, `chat:before-request`, `ui:slot-action` and `ui:slot-data`, plus `conversation.tabs`, `composer.toolbar` and `overlay.notice` in the `slots` whitelist; `plugins:storage` is used for the one-time migration of the interim plugin-storage snapshot and holds the humanizing switch, `assets:read` is the remote fetch channel of the asset market, `settings:surface` registers the source switches and the custom-source fields, and `ui:slot` together with the two slot mounts registers "asset market" as a tab in the conversation view tab bar, "Humanize" as a toolbar button, and the asset state as a notice card (see the "Asset market" and "Humanizing switch and asset state notice" sections above).

The engine rate-limits `ui:slot` per registration (20 calls / 10 s, covering `registerSlot`, `onSlotAction` and `onSlotData`): activation registers three slots, two action registrations (market tab and toolbar — the engine keeps one action handler per plugin and the payload's `slot` routes it) and one data handler, and every flip adds one `registerSlot` (same-id replacement), far inside the budget.

## Publishing

- Ship the whole `dist/` directory, not just `plugin.js`: `meta.json` is what a market reads to identify the plugin, and `MUST_PLUSH_WITH_PACKAGE` states that the directory must ship as a package.
- Do not rename the directory layout, the `meta.json` fields or the `.author.sig` files; markets and collections parse them by convention.
- When you sign as the author, ship `plugin.js.author.sig` and `author_pub.pem`, and hand the public key to the collection so it lands at `plugins/<author>/author_pub.pem`.
- Host the output on a static site or CDN that serves `https` and keep the URL stable; a dead URL affects update checks and reinstalls, while startup restores installed plugins from the code saved at install time.
- Before publishing, run `import('https://your-host/plugin.js')` once in the browser console to confirm there is no syntax error and no missing dependency.
- `dist/` is ignored by `.gitignore`; attach the output to a release when you need to ship it.
- Plugins run in the user browser and can read the visible fields of the current conversation, but not the API key, attachment originals or other plugins' data; any distribution must tell users to install only plugins from sources they trust.
- [README.user.md](README.user.md) is the end-user document; keep it in sync when features change.

## FAQ

### The output has an extra or a missing file

The build clears `dist/` and checks the output list; only `meta.json`, `plugin.js`, `MUST_PLUSH_WITH_PACKAGE` and, when author signing is on, `plugin.js.author.sig` and `author_pub.pem` are allowed. Anything else means the source uses dynamic `import()` or pulls in an asset that needs a separate output.

### meta.json fails validation

The build validates against the rules in `schemas/runtime/meta.json` and names the failing field. Common causes are a `name` in `package.json` that does not match `dsc-xxx`, a `version` without three numeric segments, a `dsc` block missing `engines` or `repo_link`, or an `author` written as an object.

### No signature is produced

`AUTHOR_SIGN_ENABLE` accepts only `true` (case and surrounding spaces are ignored); `1`, `yes` and similar values count as off. When signing is on and `AUTHOR_SIGN_PRIVATE_KEY` is missing, is not PKCS#8 PEM, or is not an Ed25519 key, the build fails and prints the reason.

A signature that fails verification usually means a file was re-saved between signing and delivery: CRLF against LF alone is enough to break it.

### Missing manifest

The install result is `invalid-manifest` and the host shows `pluginManifestMissing`, which usually means the output does not export `manifest`. Make sure [src/index.ts](src/index.ts) keeps `export { manifest } from './manifest.js'` and that `build.mjs` still uses `src/index.ts` as the entry point.

### Incompatible version

The install result is `incompatible-version`, which means `engines` does not match the host dsc-core version. The manifest declares `^1.0.0`; adjust `engines` when the host major version changes.

### Install from a URL fails

First check that the output URL itself is reachable: opening it in a new tab should return the script, not a 404, an error page or a login redirect. Then check CORS: the host fetches the output bytes, so a cross-origin host must return `Access-Control-Allow-Origin`; without that header the browser reports a CORS error and the install result is `artifact-unreachable`. Serving the output from the same domain as the page avoids the restriction.

## License

[Apache-2.0](LICENSE).