---
"@vndv/pi-codegraph": patch
---

fix(codegraph_files): normalize non-root-anchored path filters and hint on empty results

CodeGraph treats the `codegraph_files` `path` argument as a prefix anchored at the project
root and silently returns a non-error "No files found" for absolute paths, `~` paths, or
bare directory names — which makes agents wrongly conclude a directory does not exist.
Absolute/`~` paths inside the project are now translated to repo-relative prefixes, and
empty filtered results gain a deterministic hint so the agent can self-correct.
