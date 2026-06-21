---
"@vndv/pi-codegraph": patch
---

Fix MCP session hangs and Windows path normalization

- Add 20-second session timeout with child process kill to prevent infinite "working..." hangs
- Add Git Bash (`/c/...`) and WSL (`/mnt/c/...`) path normalization in `resolveProjectCwd`, gated behind `process.platform === "win32"`
- Fix timer leak: clear timeout and remove abort listener in `.finally()` on every code path
- Suppress unhandled rejections from both Promise.race losers
