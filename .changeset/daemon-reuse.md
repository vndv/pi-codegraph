---
"@vndv/pi-codegraph": minor
---

Reuse CodeGraph daemon across tool calls instead of spawning a new process per request

**Before:** Each tool call spawned a new `codegraph serve --mcp` process, causing cold-start delays and timeouts on large projects.

**After:** A single daemon is cached per project path and reused across calls. The daemon shuts down after 5 minutes of inactivity and is automatically restarted on the next request.

Benefits:
- **First call:** spawns daemon (cold start)
- **Subsequent calls:** reuses daemon (~instant)
- **No calls for 5min:** daemon shuts down, next call respawns
- Concurrent requests share the same daemon safely (JSON-RPC multiplexing)
- Process exit cleans up all daemons
