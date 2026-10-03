---
"@vndv/pi-codegraph": patch
---

Default `projectPath` to the pi session's working directory (`ctx.cwd`) so CodeGraph tools work when pi runs embedded with a different process cwd (e.g. pi-web). Fixes #71.
