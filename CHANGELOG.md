# @vndv/pi-codegraph

## 0.1.8

### Patch Changes

- f8a0a7e: Normalize `codegraph_files` `path` filters to root-relative POSIX prefixes and append a deterministic hint when no files match, preventing agents from concluding a directory does not exist. Fixes #40.
- f8a0a7e: Remove `codegraph_context` and `codegraph_trace` tools, which upstream CodeGraph dropped in v0.9.9+, and update guidance to use `codegraph_explore` instead. Fixes #37.

## 0.1.7

### Patch Changes

- Allow installation on Node.js versions newer than 22.19.0.

## 0.1.6

### Patch Changes

- 5f13a98: Add an automatically updated Skylos grade badge to the README.

## 0.1.5

### Patch Changes

- 0852fcd: Link the README navigation items to their sections.

## 0.1.4

### Patch Changes

- 1e5479b: Harden CI and release workflows, add Skylos policy files, and split JSON-RPC session helpers.

## 0.1.3

### Patch Changes

- c72e6ab: Add CodeGraph compatibility tracking and Dependabot configuration.

## 0.1.2

### Patch Changes

- 4b81198: Update README install, uninstall, and release instructions.

## 0.1.1

### Patch Changes

- 93aa337: Harden CodeGraph MCP launch by validating project paths and redacting sensitive process diagnostics.
