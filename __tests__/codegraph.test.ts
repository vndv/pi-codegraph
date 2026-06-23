import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Reset daemon manager between tests to avoid state leaking
beforeEach(async () => {
  const mod = await import("../extensions/codegraph.js");
  mod.getDaemonManager().killAll();
});

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

  it("uses the direct codegraph executable outside Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const { spawn } = await import("node:child_process");
    const { withCodeGraphMcp, getDaemonManager } = await import("../extensions/codegraph.js");

    // Kill any cached daemon so spawn is called fresh
    getDaemonManager().killAll();

    await withCodeGraphMcp(process.cwd(), undefined, async () => "success");

    expect(spawn).toHaveBeenCalledWith("codegraph", ["serve", "--mcp", "--path", process.cwd()], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  });

  it("uses PowerShell command discovery for the CodeGraph executable on Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const { spawn } = await import("node:child_process");
    const { withCodeGraphMcp, getDaemonManager } = await import("../extensions/codegraph.js");

    // Kill any cached daemon so spawn is called fresh
    getDaemonManager().killAll();

    await withCodeGraphMcp(process.cwd(), undefined, async () => "success");

    const [command, args, options] = vi.mocked(spawn).mock.calls.at(-1)!;
    const spawnArgs = args as string[];
    const script = spawnArgs[spawnArgs.indexOf("-Command") + 1];

    expect(command).toBe("powershell.exe");
    expect(spawnArgs).toEqual(expect.arrayContaining([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
    ]));
    expect(script).toContain("Get-Command codegraph");
    expect(script).toContain("-CommandType Application");
    expect(script).toContain("Select-Object -First 1");
    expect(script).not.toContain("codegraph.cmd");
    expect(script).not.toMatch(/Users[\\/]cq/i);
    expect(script).not.toMatch(/scoop/i);
    expect(spawnArgs.at(-1)).toBe(process.cwd());
    expect(options).toEqual({
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  });

  it("validates projectPath before starting CodeGraph", async () => {
    const { resolveProjectCwd } = await import("../extensions/codegraph.js");

    await expect(resolveProjectCwd("relative/project")).rejects.toThrow("absolute path");
    await expect(resolveProjectCwd("/path/that/does/not/exist")).rejects.toThrow("does not exist");
    await expect(resolveProjectCwd(fileURLToPath(import.meta.url))).rejects.toThrow("directory");
  });

  it("preserves Unix paths on macOS/Linux", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });

    const { resolveProjectCwd } = await import("../extensions/codegraph.js");
    const cwd = await resolveProjectCwd(process.cwd());
    expect(cwd).toBe(process.cwd());
  });

  it("normalizes WSL and Git Bash paths on Windows", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });

    const { normalizeWindowsPath } = await import("../extensions/codegraph.js");

    expect(normalizeWindowsPath("/mnt/c/Users/dev/project")).toBe("C:\\Users\\dev\\project");
    expect(normalizeWindowsPath("/c/Users/dev/project")).toBe("C:\\Users\\dev\\project");
    expect(normalizeWindowsPath("/Users/vndv/project")).toBe("/Users/vndv/project");
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

  it("reuses daemon across multiple calls", async () => {
    const { spawn } = await import("node:child_process");
    const { callCodeGraphTool, getDaemonManager } = await import("../extensions/codegraph.js");

    getDaemonManager().killAll();
    const spawnCallsBefore = vi.mocked(spawn).mock.calls.length;

    await callCodeGraphTool("codegraph_status", {});
    await callCodeGraphTool("codegraph_status", {});

    // Daemon should only spawn once, not twice
    const spawnCallsAfter = vi.mocked(spawn).mock.calls.length;
    expect(spawnCallsAfter - spawnCallsBefore).toBe(1);
  });

  it("kills daemon after idle timeout", async () => {
    vi.useFakeTimers();
    const { spawn } = await import("node:child_process");
    const { callCodeGraphTool, getDaemonManager, DaemonIdleTimeoutMs } = await import("../extensions/codegraph.js");

    getDaemonManager().killAll();
    await callCodeGraphTool("codegraph_status", {});

    const child = vi.mocked(spawn).mock.results[0]?.value;
    expect(child).toBeDefined();

    // Advance past idle timeout
    vi.advanceTimersByTime(DaemonIdleTimeoutMs + 1);

    // Daemon should be killed
    expect(child.killed).toBe(true);

    vi.useRealTimers();
  });

  it("times out when the MCP request never completes", async () => {
    const { spawn } = await import("node:child_process");

    // Create a process that responds to initialize but not tools/call
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
          // Don't respond to tools/call - simulate timeout
        }
      });

      return child;
    });

    const { withCodeGraphMcp, getDaemonManager, SessionTimeoutMs } = await import("../extensions/codegraph.js");
    getDaemonManager().killAll();

    const promise = withCodeGraphMcp(process.cwd(), undefined, async (request) => {
      return request("tools/call", { name: "test" });
    });

    await expect(promise).rejects.toThrow("CodeGraph MCP request timed out after " + SessionTimeoutMs);
  }, 25000);

  it("normalizes codegraph_files path before forwarding to the MCP server", async () => {
    const { spawn } = await import("node:child_process");
    const { callCodeGraphTool, getDaemonManager } = await import("../extensions/codegraph.js");
    let capturedArgs: Record<string, unknown> | undefined;

    getDaemonManager().killAll();

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
