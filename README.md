# pi-codegraph

Pi package that adds CodeGraph tools to Pi Agent.

## Requirements

Node.js 22 LTS is recommended. CodeGraph blocks Node.js 25 because of a V8 WASM JIT bug in tree-sitter grammar compilation.

Pi provides the package extension runtime and core libraries. This package declares `@earendil-works/pi-coding-agent` and `typebox` as peer dependencies, as required by Pi package loading.

CodeGraph must already be installed and available on `PATH`:

```bash
npm install -g @colbymchenry/codegraph
```

Projects must be indexed before Pi can query them:

```bash
cd /path/to/project
codegraph init -i
```

## Install

From GitHub:

```bash
pi install https://github.com/vndv/pi-codegraph
```

From npm:

```bash
pi install npm:pi-codegraph@0.1.0
```

This works only after `pi-codegraph@0.1.0` has been published to npm. If npm returns `404 Not Found`, use the GitHub or local development install until the first npm publish is complete.

Local development install:

```bash
git clone https://github.com/vndv/pi-codegraph.git
cd pi-codegraph
pi install "$(pwd)"
```

Verify Pi sees the package:

```bash
pi list
```

## Uninstall

Remove the package using the same source shown by `pi list`:

```bash
pi remove https://github.com/vndv/pi-codegraph
```

If you installed from npm or a local path, remove that exact entry instead:

```bash
pi remove npm:pi-codegraph@0.1.0
pi remove /path/to/pi-codegraph
```

Then start Pi inside an indexed project:

```bash
cd /path/to/project
pi
```

Example prompt:

```text
Use CodeGraph. Show project structure and main entry points.
```

## Tools

This package registers:

- `codegraph_search`
- `codegraph_context`
- `codegraph_callers`
- `codegraph_callees`
- `codegraph_impact`
- `codegraph_explore`
- `codegraph_node`
- `codegraph_status`
- `codegraph_files`
- `codegraph_trace`

Each tool proxies to:

```bash
codegraph serve --mcp --path <project>
```

For broad code questions, Pi should prefer `codegraph_context`. For known symbols, use `codegraph_node`. Use `codegraph_search` for declaration/symbol lookup, not literal constants or arbitrary text.

## Development

```bash
npm ci
npm run ci
```

## Release

Run the full local package check before publishing:

```bash
npm run ci
npm pack --dry-run
```

First npm publish:

```bash
npm login
npm publish --access public
```

Future releases use Changesets:

```bash
npx changeset
npm run local-release
```

GitHub publishing is also supported:

1. Add `NPM_TOKEN` repository secret in GitHub.
2. Update the package version with Changesets or by editing `package.json`.
3. Commit and push to `main`.
4. Create a GitHub release for the version tag.

The publish workflow runs `npm publish --provenance`.
