import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => createMockProcess()),
}));

function createMockProcess(returnResult?: { content?: any[]; isError?: boolean }) {
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
        const result = returnResult ?? { content: [{ type: "text", text: `called ${msg.params.name}` }] };
        child.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result,
        }) + "\n");
      }
    }
  });

  return child;
}

describe("pi-codegraph extension", () => {
  it("exports all CodeGraph tool names", async () => {
    const mod = await import("../extensions/codegraph.js");

    expect(mod.codegraphToolNames).not.toContain("codegraph_context");
    expect(mod.codegraphToolNames).not.toContain("codegraph_trace");
    expect(mod.codegraphToolNames).toHaveLength(8);
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

  describe("normalizeFilesPath", () => {
    it("returns undefined for empty/undefined input", async () => {
      const { normalizeFilesPath } = await import("../extensions/codegraph.js");

      expect(normalizeFilesPath()).toBeUndefined();
      expect(normalizeFilesPath("")).toBeUndefined();
    });

    it("expands ~ to the home directory", async () => {
      const { normalizeFilesPath } = await import("../extensions/codegraph.js");
      vi.spyOn(os, "homedir").mockReturnValue("/home/user");

      expect(normalizeFilesPath("~/project/src/components", "/home/user/project")).toBe("src/components");
      expect(normalizeFilesPath("~/project", "/home/user/project")).toBeUndefined();
    });

    it("converts an absolute path inside the project to a repo-relative POSIX prefix", async () => {
      const { normalizeFilesPath } = await import("../extensions/codegraph.js");

      expect(normalizeFilesPath(path.join(process.cwd(), "src/components"), process.cwd())).toBe("src/components");
    });

    it("drops the filter when the path equals the project root", async () => {
      const { normalizeFilesPath } = await import("../extensions/codegraph.js");

      expect(normalizeFilesPath(process.cwd(), process.cwd())).toBeUndefined();
    });

    it("leaves relative inputs and out-of-project absolute paths untouched", async () => {
      const { normalizeFilesPath } = await import("../extensions/codegraph.js");

      expect(normalizeFilesPath("components", "/project")).toBe("components");
      expect(normalizeFilesPath("/outside/project", "/project")).toBe("/outside/project");
    });
  });

  describe("annotateFilesResult", () => {
    it("appends a hint to the bare empty marker when a path filter was supplied", async () => {
      const { annotateFilesResult } = await import("../extensions/codegraph.js");

      const result = annotateFilesResult("No files found matching the criteria.", "components");
      expect(result).toContain("Hint:");
      expect(result).toContain("root-relative POSIX prefix");
      expect(result).toContain('"components"');
    });

    it("returns non-empty text unchanged", async () => {
      const { annotateFilesResult } = await import("../extensions/codegraph.js");

      expect(annotateFilesResult("src/Button.ts", "components")).toBe("src/Button.ts");
    });

    it("returns the empty marker unchanged when no path filter was supplied", async () => {
      const { annotateFilesResult } = await import("../extensions/codegraph.js");

      expect(annotateFilesResult("No files found matching the criteria.")).toBe(
        "No files found matching the criteria.",
      );
    });
  });

  it("normalizes codegraph_files path before forwarding to the MCP server", async () => {
    const { spawn } = await import("node:child_process");
    const { callCodeGraphTool } = await import("../extensions/codegraph.js");
    let capturedArgs: Record<string, unknown> | undefined;

    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = new EventEmitter() as any;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = vi.fn(() => { child.killed = true; });

      child.stdin.on("data", (chunk: Buffer) => {
        const lines = chunk.toString("utf-8").trim().split("\n").filter(Boolean);
        for (const line of lines) {
          const msg = JSON.parse(line);
          if (msg.method === "initialize") {
            child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
          }
          if (msg.method === "tools/call") {
            capturedArgs = msg.params.arguments;
            child.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { content: [{ type: "text", text: "src/Button.ts" }] },
            }) + "\n");
          }
        }
      });

      return child;
    });

    await callCodeGraphTool("codegraph_files", {
      projectPath: process.cwd(),
      path: path.join(process.cwd(), "src"),
    });

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.path).toBe("src");
  });
});
