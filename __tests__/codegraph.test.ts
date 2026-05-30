import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => createMockProcess()),
}));

function createMockProcess() {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
  });

  child.stdin.on("data", (chunk: Buffer) => {
    const lines = chunk.toString("utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
      }
      if (msg.method === "tools/call") {
        child.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: `called ${msg.params.name}` }] },
        }) + "\n");
      }
    }
  });

  return child;
}

describe("pi-codegraph extension", () => {
  it("exports all CodeGraph tool names", async () => {
    const mod = await import("../extensions/codegraph.js");

    expect(mod.codegraphToolNames).toContain("codegraph_context");
    expect(mod.codegraphToolNames).toContain("codegraph_trace");
    expect(mod.codegraphToolNames).toHaveLength(10);
  });

  it("proxies tool calls through CodeGraph MCP", async () => {
    const { callCodeGraphTool } = await import("../extensions/codegraph.js");

    await expect(callCodeGraphTool("codegraph_status", {})).resolves.toBe("called codegraph_status");
  });

  it("validates projectPath before starting CodeGraph", async () => {
    const { resolveProjectCwd } = await import("../extensions/codegraph.js");

    await expect(resolveProjectCwd("relative/project")).rejects.toThrow("absolute path");
    await expect(resolveProjectCwd("/path/that/does/not/exist")).rejects.toThrow("does not exist");
    await expect(resolveProjectCwd(new URL(import.meta.url).pathname)).rejects.toThrow("directory");
  });

  it("redacts sensitive stderr diagnostics", async () => {
    const { sanitizeDiagnostic } = await import("../extensions/codegraph.js");

    const diagnostic = sanitizeDiagnostic(
      "\u001b[31mfailed TOKEN=abc123 Bearer secret-token --otp 123456 --api-key=hidden\u001b[0m",
    );

    expect(diagnostic).toContain("TOKEN=[redacted]");
    expect(diagnostic).toContain("Bearer [redacted]");
    expect(diagnostic).toContain("--[redacted]");
    expect(diagnostic).not.toContain("abc123");
    expect(diagnostic).not.toContain("secret-token");
    expect(diagnostic).not.toContain("123456");
    expect(diagnostic).not.toContain("hidden");
  });
});
