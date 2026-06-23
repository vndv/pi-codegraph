---
"@vndv/pi-codegraph": patch
---

Make MCP session timeout configurable via `CODEGRAPH_TIMEOUT_MS` environment variable

The default timeout has been increased from 20s to 60s to accommodate larger projects where `codegraph serve --mcp` cold start exceeds the previous limit. Users can override via:

```bash
export CODEGRAPH_TIMEOUT_MS=90000  # 90 seconds
```
