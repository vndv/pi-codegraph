# pi-codegraph
### CodeGraph tools for pi

[![Skylos Grade](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/vndv/pi-codegraph/main/.github/badges/skylos.json)](https://github.com/duriantaco/skylos)
[![npm downloads](https://img.shields.io/npm/dm/%40vndv%2Fpi-codegraph)](https://www.npmjs.com/package/@vndv/pi-codegraph)

[Install](#install) · [Usage](#usage) · [How it works](#how-it-works)

Ask pi structural questions about your codebase without falling back to slow grep/read loops.

An extension for [pi](https://pi.dev) that gives the agent access to [CodeGraph](https://github.com/colbymchenry/codegraph) tools. CodeGraph indexes your project with tree-sitter, then pi can query symbols, callers, callees, dependency impact, files, and call paths through native extension tools.

---

## Quick start

```bash
npm install -g @colbymchenry/codegraph
cd /path/to/project
codegraph init -i
pi install npm:@vndv/pi-codegraph@0.1.6
pi
```

Then ask:

```text
Use CodeGraph. Show project structure and main entry points.
```

---

## What's included

Extension tools only. There is no MCP setup for pi users to maintain.

| Tool | Description |
| --- | --- |
| `codegraph_context` | Broad task context: entry points, related symbols, callers, callees, and key code |
| `codegraph_search` | Symbol search by name |
| `codegraph_node` | One symbol's signature, location, source, callers, and callees |
| `codegraph_files` | Indexed file tree |
| `codegraph_callers` | Functions or methods that call a symbol |
| `codegraph_callees` | Functions or methods called by a symbol |
| `codegraph_trace` | Static call path from one symbol to another |
| `codegraph_impact` | Impact radius for changing a symbol |
| `codegraph_explore` | Source for several related symbols grouped by file |
| `codegraph_status` | Index health and pending sync status |

---

## Install

From npm:

```bash
pi install npm:@vndv/pi-codegraph@0.1.6
```

From GitHub:

```bash
pi install https://github.com/vndv/pi-codegraph
```

Local development install:

```bash
git clone https://github.com/vndv/pi-codegraph.git
cd pi-codegraph
pi install "$(pwd)"
```

Then `/reload` in pi, or restart pi.

Verify pi sees the package:

```bash
pi list
```

---

## Requirements

Node.js 22 LTS is recommended. CodeGraph blocks Node.js 25 because that Node line has a V8 WASM JIT issue that can crash while compiling tree-sitter grammars.

CodeGraph must be installed and available on `PATH`:

```bash
npm install -g @colbymchenry/codegraph
```

This extension is tested against the `@colbymchenry/codegraph` npm package declared in `devDependencies`. Dependabot watches that package and opens update PRs when CodeGraph releases a new version.

Each project must be indexed before pi can query it:

```bash
cd /path/to/project
codegraph init -i
```

This package declares `@earendil-works/pi-coding-agent` and `typebox` as peer dependencies because pi provides the extension runtime.

---

## Usage

### 1. Start pi inside an indexed project

```bash
cd /path/to/project
pi
```

### 2. Ask structural questions

Good prompts:

```text
Use CodeGraph. Explain how authentication reaches the request handler.
Use CodeGraph. What calls PlanBoostSession?
Use CodeGraph. What would break if I change UserRepository?
Use CodeGraph. Show files under internal/services and important symbols.
```

### 3. Prefer the right tool

Use `codegraph_context` for broad "how does this work?" questions.

Use `codegraph_node` when you already know the symbol name.

Use `codegraph_trace` for "how does X reach Y?" flow questions.

Use `codegraph_search` for declarations and symbols, not arbitrary text or constant values.

---

## How it works

pi extensions are not MCP configuration files. This package registers native pi tools, and each tool proxies one request to CodeGraph's MCP server internally:

```bash
codegraph serve --mcp --path <project>
```

The flow is:

```text
pi agent
  -> pi-codegraph extension tool
  -> local CodeGraph MCP process
  -> .codegraph/codegraph.db in the current project
  -> structured result back to pi
```

That means another developer only needs the npm package, the `codegraph` CLI, and an initialized `.codegraph` index in their project. They do not need to edit pi MCP config.

---

## Uninstall

Remove the package using the same source shown by `pi list`:

```bash
pi remove npm:@vndv/pi-codegraph@0.1.6
```

If you installed from GitHub or a local path, remove that exact entry instead:

```bash
pi remove https://github.com/vndv/pi-codegraph
pi remove /path/to/pi-codegraph
```

Then `/reload` in pi, or restart pi.

---

## Troubleshooting

### `codegraph_*` tools are missing

Check that pi installed the package:

```bash
pi list
```

Then reload or restart pi.

### CodeGraph says the project is not initialized

Run:

```bash
cd /path/to/project
codegraph init -i
```

### Node.js version is unsupported

Use Node.js 22 LTS:

```bash
nvm install 22
nvm use 22
```

---

## Development

```bash
npm ci
npm run ci
```

`npm run ci` type-checks the extension, runs tests, verifies the pinned CodeGraph CLI can start, and dry-runs the npm package.

Install the local checkout into pi:

```bash
pi install /Users/vndv/Documents/programming/open-source/pi-codegraph
```

Before opening a pull request:

```bash
npm run ci
```

---

## Release

The package is published to npm as `@vndv/pi-codegraph`.

Releases are automated with Changesets. Any package update, including README changes shipped to npm, needs a changeset so the release workflow can bump the version and deploy a new npm package.

For every user-facing change, add a changeset in the feature branch:

```bash
npx changeset
```

Choose the bump type:

- `patch` for fixes and docs that affect package users
- `minor` for new tools or behavior
- `major` for breaking changes

After the PR is merged to `main`, the release workflow opens or updates a `chore: version packages` pull request. That PR contains the version bump and changelog update.

Merge the version PR to publish to npm automatically.

The workflow runs:

```bash
npm run version-packages
npm run publish-packages
```

`publish-packages` runs `npm publish --access public --provenance`.

The workflow uses npm trusted publishing through GitHub Actions OIDC.

Local release commands are still available when needed:

```bash
npm run ci
npm run local-release
```

GitHub Actions needs npm trusted publishing configured for `.github/workflows/publish.yml`.

---

## License

MIT
