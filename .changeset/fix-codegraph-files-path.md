---
"@vndv/pi-codegraph": patch
---

Normalize `codegraph_files` `path` filters to root-relative POSIX prefixes and append a deterministic hint when no files match, preventing agents from concluding a directory does not exist. Fixes #40.
