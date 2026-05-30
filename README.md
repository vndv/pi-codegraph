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

Local development install:

```bash
pi install /Users/vndv/Documents/programming/open-source/pi-codegraph
```

Verify Pi sees the package:

```bash
pi list
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

1. Update `version` in `package.json`.
2. Commit changes and push to `main`.
3. Create GitHub repo `vndv/pi-codegraph` and push:

```bash
git remote add origin git@github.com:vndv/pi-codegraph.git
git push -u origin main
```

4. Add `NPM_TOKEN` repository secret in GitHub.
5. Create GitHub release for the version tag.

The publish workflow runs `npm publish --provenance`.
