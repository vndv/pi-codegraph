import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OptionalProjectPath = Type.Optional(Type.String({
  description: "Path to a different project with .codegraph/ initialized. Defaults to current project.",
}));

const ToolKind = Type.Optional(Type.Union([
  Type.Literal("function"),
  Type.Literal("method"),
  Type.Literal("class"),
  Type.Literal("interface"),
  Type.Literal("type"),
  Type.Literal("variable"),
  Type.Literal("route"),
  Type.Literal("component"),
]));

const ToolDefinitions = [
  {
    name: "codegraph_search",
    label: "CodeGraph Search",
    description: "Quick symbol search by name. Returns locations only.",
    parameters: Type.Object({
      query: Type.String({ description: "Symbol name or partial name." }),
      kind: ToolKind,
      limit: Type.Optional(Type.Number({ default: 10 })),
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_callers",
    label: "CodeGraph Callers",
    description: "Find all functions or methods that call a specific symbol.",
    parameters: Type.Object({
      symbol: Type.String(),
      limit: Type.Optional(Type.Number({ default: 20 })),
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_callees",
    label: "CodeGraph Callees",
    description: "Find all functions or methods that a specific symbol calls.",
    parameters: Type.Object({
      symbol: Type.String(),
      limit: Type.Optional(Type.Number({ default: 20 })),
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_impact",
    label: "CodeGraph Impact",
    description: "Analyze the impact radius of changing a symbol.",
    parameters: Type.Object({
      symbol: Type.String(),
      depth: Type.Optional(Type.Number({ default: 2 })),
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_explore",
    label: "CodeGraph Explore",
    description: "Return source for several related symbols grouped by file.",
    parameters: Type.Object({
      query: Type.String({ description: "Specific symbols, files, or code terms to explore." }),
      maxFiles: Type.Optional(Type.Number({ default: 12 })),
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_node",
    label: "CodeGraph Node",
    description: "Get one symbol's details plus callers and callees trail.",
    parameters: Type.Object({
      symbol: Type.String(),
      includeCode: Type.Optional(Type.Boolean({ default: false })),
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_status",
    label: "CodeGraph Status",
    description: "Get CodeGraph index status.",
    parameters: Type.Object({
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_files",
    label: "CodeGraph Files",
    description: "Get project file structure from the CodeGraph index.",
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
      pattern: Type.Optional(Type.String()),
      format: Type.Optional(Type.Union([
        Type.Literal("tree"),
        Type.Literal("flat"),
        Type.Literal("grouped"),
      ], { default: "tree" })),
      includeMetadata: Type.Optional(Type.Boolean({ default: true })),
      maxDepth: Type.Optional(Type.Number()),
      projectPath: OptionalProjectPath,
    }),
  },
] as const;

type ToolName = (typeof ToolDefinitions)[number]["name"];
type ToolParams = Record<string, unknown> & { projectPath?: string };
type JsonRpcRequest = (method: string, params: Record<string, unknown>) => Promise<any>;
type PendingJsonRpcRequests = Map<number, {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}>;

export const MaxDiagnosticLength = 1000;
export const SessionTimeoutMs = 20_000;
export const DaemonIdleTimeoutMs = 300_000; // 5 minutes

export const codegraphToolNames = ToolDefinitions.map((tool) => tool.name);

const WindowsCodeGraphLaunchScript = [
  "& {",
  "param([string]$ProjectPath)",
  "$ErrorActionPreference = 'Stop';",
  "$cmd = Get-Command codegraph -CommandType Application -ErrorAction Stop | Select-Object -First 1;",
  "if (-not $cmd) { throw 'codegraph command not found'; }",
  "& $cmd.Source serve --mcp --path $ProjectPath;",
  "exit $LASTEXITCODE;",
  "}",
].join(" ");

function spawnCodeGraphServer(cwd: string): ChildProcessWithoutNullStreams {
  if (process.platform !== "win32") {
    return spawn("codegraph", ["serve", "--mcp", "--path", cwd], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  // On Windows, Node's direct spawn can miss npm/Scoop command shims that the
  // shell resolves correctly. Use PowerShell command discovery so global CLI
  // installs are found without hardcoding .cmd, Scoop, npm, or user paths.
  return spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    WindowsCodeGraphLaunchScript,
    cwd,
  ], {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

// ─── Daemon Manager ──────────────────────────────────────────────────────────

interface DaemonEntry {
  child: ChildProcessWithoutNullStreams;
  pending: PendingJsonRpcRequests;
  nextId: number;
  initialized: boolean;
  stdoutBuffer: string;
  stderrBuffer: string;
  refCount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  dead: boolean;
}

class DaemonManager {
  private daemons = new Map<string, DaemonEntry>();
  private cleanupRegistered = false;

  private ensureCleanup(): void {
    if (this.cleanupRegistered) return;
    this.cleanupRegistered = true;

    const cleanup = () => this.killAll();
    process.on("exit", cleanup);
    process.on("SIGINT", () => { cleanup(); process.exit(130); });
    process.on("SIGTERM", () => { cleanup(); process.exit(143); });
  }

  async acquire(cwd: string): Promise<DaemonEntry> {
    this.ensureCleanup();

    let entry = this.daemons.get(cwd);

    // Reuse existing daemon if alive
    if (entry && !entry.dead) {
      entry.refCount++;
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
      return entry;
    }

    // Spawn new daemon
    const child = spawnCodeGraphServer(cwd);
    entry = {
      child,
      pending: new Map(),
      nextId: 1,
      initialized: false,
      stdoutBuffer: "",
      stderrBuffer: "",
      refCount: 1,
      idleTimer: null,
      dead: false,
    };

    this.attachHandlers(entry, cwd);
    this.daemons.set(cwd, entry);

    // Initialize MCP session
    await this.initialize(entry, cwd);

    return entry;
  }

  release(cwd: string): void {
    const entry = this.daemons.get(cwd);
    if (!entry || entry.dead) return;

    entry.refCount--;
    if (entry.refCount <= 0) {
      entry.refCount = 0;
      entry.idleTimer = setTimeout(() => this.kill(cwd), DaemonIdleTimeoutMs);
    }
  }

  kill(cwd: string): void {
    const entry = this.daemons.get(cwd);
    if (!entry) return;

    entry.dead = true;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    rejectPendingRequests(entry.pending, new Error("CodeGraph daemon shut down."));
    if (!entry.child.killed) entry.child.kill();
    this.daemons.delete(cwd);
  }

  killAll(): void {
    for (const cwd of this.daemons.keys()) {
      this.kill(cwd);
    }
  }

  private attachHandlers(entry: DaemonEntry, _cwd: string): void {
    entry.child.stdout.on("data", (chunk: Buffer) => {
      entry.stdoutBuffer += chunk.toString("utf-8");
      let newline;
      while ((newline = entry.stdoutBuffer.indexOf("\n")) !== -1) {
        const line = entry.stdoutBuffer.slice(0, newline).trim();
        entry.stdoutBuffer = entry.stdoutBuffer.slice(newline + 1);
        if (line) resolveJsonRpcLine(line, entry.pending);
      }
    });

    entry.child.stderr.on("data", (chunk: Buffer) => {
      entry.stderrBuffer += chunk.toString("utf-8");
    });

    entry.child.on("error", () => {
      entry.dead = true;
      rejectPendingRequests(entry.pending, new Error("CodeGraph daemon error."));
    });

    entry.child.on("exit", (code) => {
      entry.dead = true;
      if (entry.pending.size > 0) {
        const diagnostic = sanitizeDiagnostic(entry.stderrBuffer.trim());
        const msg = diagnostic || `CodeGraph daemon exited with code ${code}`;
        rejectPendingRequests(entry.pending, new Error(msg));
      }
      this.daemons.delete(_cwd);
    });
  }

  private async initialize(entry: DaemonEntry, cwd: string): Promise<void> {
    const rootUri = pathToFileURL(cwd).href;
    const sendRequest = this.createSender(entry);

    await sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: cwd.split(/[\\/]/).pop() || cwd }],
      capabilities: {},
      clientInfo: { name: "pi-codegraph", version: "0.1.0" },
    });

    // Send initialized notification
    entry.child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "initialized",
      params: {},
    }) + "\n");

    entry.initialized = true;
  }

  createSender(entry: DaemonEntry): JsonRpcRequest {
    return (method, params) => {
      const id = entry.nextId++;
      const payload = { jsonrpc: "2.0", id, method, params };
      const promise = new Promise<any>((resolve, reject) => {
        entry.pending.set(id, { resolve, reject });
      });
      entry.child.stdin.write(`${JSON.stringify(payload)}\n`);
      return promise;
    };
  }
}

// Singleton manager
const daemonManager = new DaemonManager();

// Exported for testing
export function getDaemonManager(): DaemonManager {
  return daemonManager;
}

// ─── Session (reuses daemon) ─────────────────────────────────────────────────

async function withDaemonSession<T>(
  projectPath: string | undefined,
  signal: AbortSignal | undefined,
  fn: (request: JsonRpcRequest) => Promise<T>,
): Promise<T> {
  const cwd = await resolveProjectCwd(projectPath);
  const entry = await daemonManager.acquire(cwd);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbortClearTimer = () => clearTimeout(timer);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(
        "CodeGraph MCP request timed out after " + SessionTimeoutMs + "ms. " +
        'Try running "codegraph unlock" in the project directory, then restart pi.'
      ));
    }, SessionTimeoutMs);
    signal?.addEventListener("abort", onAbortClearTimer, { once: true });
  });

  const sendRequest = daemonManager.createSender(entry);
  const task = fn(sendRequest);

  try {
    return await Promise.race([task, timeout]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbortClearTimer);
    daemonManager.release(cwd);
  }
}

// Keep backward-compatible export
export const withCodeGraphMcp = withDaemonSession;

// ─── Utilities ───────────────────────────────────────────────────────────────

export function normalizeWindowsPath(inputPath: string): string {
  let normalized = inputPath.trim();

  if (process.platform !== "win32") return normalized;

  const wslMatch = normalized.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (wslMatch) {
    normalized = wslMatch[1].toUpperCase() + ":\\" + wslMatch[2].replace(/\//g, "\\");
  }

  const gitBashMatch = normalized.match(/^\/([a-zA-Z])\/(.*)$/);
  if (gitBashMatch) {
    normalized = gitBashMatch[1].toUpperCase() + ":\\" + gitBashMatch[2].replace(/\//g, "\\");
  }

  return normalized;
}

export async function resolveProjectCwd(projectPath: string | undefined): Promise<string> {
  const cwd = normalizeWindowsPath(projectPath || process.cwd());

  if (!path.isAbsolute(cwd)) {
    throw new Error("CodeGraph projectPath must be an absolute path.");
  }

  let info;
  try {
    info = await stat(cwd);
  } catch {
    throw new Error("CodeGraph projectPath does not exist or is not accessible.");
  }

  if (!info.isDirectory()) {
    throw new Error("CodeGraph projectPath must point to a directory.");
  }

  return cwd;
}

export function normalizeFilesPath(inputPath?: string, projectCwd?: string): string | undefined {
  if (typeof inputPath !== "string" || inputPath.trim() === "") return undefined;

  const trimmed = inputPath.trim();
  let expanded = trimmed;
  if (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }

  if (projectCwd && path.isAbsolute(expanded)) {
    const relative = path.relative(projectCwd, expanded);
    if (relative === "") return undefined;
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join("/");
    }
  }

  return trimmed.split(path.sep).join("/");
}

const EmptyFilesMarker = "No files found matching the criteria.";

export function annotateFilesResult(resultText: string, originalPath?: string): string {
  if (!originalPath || !resultText.includes(EmptyFilesMarker)) return resultText;

  return `${resultText}\n\nHint: codegraph_files interprets "path" as a root-relative POSIX prefix (e.g. "src/components"). The filter "${originalPath}" did not match any indexed path.`;
}

export function sanitizeDiagnostic(value: string): string {
  const withoutAnsi = value.replace(/\u001b\[[0-9;]*m/g, "");
  const redacted = withoutAnsi
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|AUTH)[A-Z0-9_]*=)\S+/gi, "$1[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/--(?:token|secret|password|api-key|apikey|otp)(?:=|\s+)\S+/gi, "--[redacted]");

  return redacted.length > MaxDiagnosticLength
    ? `${redacted.slice(0, MaxDiagnosticLength)}...`
    : redacted;
}

function resolveJsonRpcLine(line: string, pending: PendingJsonRpcRequests): void {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.id === undefined || !pending.has(msg.id)) return;
  const { resolve, reject } = pending.get(msg.id)!;
  pending.delete(msg.id);
  if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
  else resolve(msg.result);
}

function rejectPendingRequests(pending: PendingJsonRpcRequests, error: Error): void {
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
}

async function prepareToolArguments(
  name: ToolName,
  params: ToolParams,
): Promise<{ args: ToolParams; originalFilesPath?: string }> {
  if (name !== "codegraph_files") return { args: params };

  const projectPath = typeof params.projectPath === "string" ? params.projectPath : undefined;
  const projectCwd = await resolveProjectCwd(projectPath);
  const originalFilesPath = typeof params.path === "string" ? params.path : undefined;
  const normalizedPath = normalizeFilesPath(originalFilesPath, projectCwd);

  const args: ToolParams = { ...params };
  if (normalizedPath === undefined) {
    delete args.path;
  } else {
    args.path = normalizedPath;
  }

  return { args, originalFilesPath };
}

export async function callCodeGraphTool(
  name: ToolName,
  params: ToolParams,
  signal?: AbortSignal,
): Promise<string> {
  const { args, originalFilesPath } = await prepareToolArguments(name, params);

  const result = await withCodeGraphMcp(
    typeof args.projectPath === "string" ? args.projectPath : undefined,
    signal,
    (request) =>
      request("tools/call", {
        name,
        arguments: args,
      }),
  );

  const text = (result?.content || [])
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text)
    .join("\n");

  if (result?.isError) throw new Error(text || "CodeGraph tool failed.");
  const finalText = text || JSON.stringify(result);
  return name === "codegraph_files" ? annotateFilesResult(finalText, originalFilesPath) : finalText;
}

export default function codegraphExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    const guidance = [
      "CodeGraph tools are available as codegraph_* Pi tools.",
      "For architecture, flow, where-is-symbol, impact, and codebase navigation questions, use CodeGraph tools directly before grep/read.",
      "Use codegraph_explore first for broad questions, codegraph_search for symbol-name lookup, codegraph_files for project structure, codegraph_node for a known symbol, and codegraph_callers for impact/flow analysis.",
      "If codegraph_search returns no exact result, try codegraph_explore or codegraph_files/codegraph_node before falling back to grep/read; CodeGraph symbol search may miss literal constants or generated names that still exist in source text.",
      "Only use grep/read after CodeGraph is insufficient or when the user asks for literal text matching.",
    ].join("\n");

    return {
      systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${guidance}` : guidance,
    };
  });

  for (const tool of ToolDefinitions) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.description,
      promptGuidelines: [
        `${tool.name} is available for structural code questions backed by the local CodeGraph index.`,
      ],
      parameters: tool.parameters,
      async execute(_toolCallId, params: Static<typeof tool.parameters>, signal) {
        const text = await callCodeGraphTool(tool.name, (params || {}) as ToolParams, signal);
        return {
          content: [{ type: "text" as const, text }],
          details: {},
        };
      },
    });
  }
}
