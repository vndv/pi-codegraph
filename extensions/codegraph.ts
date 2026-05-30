import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
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
    name: "codegraph_context",
    label: "CodeGraph Context",
    description: "Primary tool for architecture, feature, bug-context, or how-does-X-work questions.",
    parameters: Type.Object({
      task: Type.String({ description: "Task, question, or code area to understand." }),
      maxNodes: Type.Optional(Type.Number({ default: 20 })),
      includeCode: Type.Optional(Type.Boolean({ default: true })),
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
  {
    name: "codegraph_trace",
    label: "CodeGraph Trace",
    description: "Trace the call path between two symbols.",
    parameters: Type.Object({
      from: Type.String(),
      to: Type.String(),
      projectPath: OptionalProjectPath,
    }),
  },
] as const;

type ToolName = (typeof ToolDefinitions)[number]["name"];
type ToolParams = Record<string, unknown> & { projectPath?: string };
type JsonRpcRequest = (method: string, params: Record<string, unknown>) => Promise<any>;

const MaxDiagnosticLength = 1000;

export const codegraphToolNames = ToolDefinitions.map((tool) => tool.name);

export async function withCodeGraphMcp<T>(
  projectPath: string | undefined,
  signal: AbortSignal | undefined,
  fn: (request: JsonRpcRequest) => Promise<T>,
): Promise<T> {
  const cwd = await resolveProjectCwd(projectPath);
  const child = spawn("codegraph", ["serve", "--mcp", "--path", cwd], {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  return runJsonRpcSession(child, cwd, signal, fn);
}

export async function resolveProjectCwd(projectPath: string | undefined): Promise<string> {
  const cwd = projectPath || process.cwd();

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

async function runJsonRpcSession<T>(
  child: ChildProcessWithoutNullStreams,
  cwd: string,
  signal: AbortSignal | undefined,
  fn: (request: JsonRpcRequest) => Promise<T>,
): Promise<T> {
  let nextId = 1;
  let stdout = "";
  let stderr = "";
  const pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();

  const cleanup = () => {
    for (const entry of pending.values()) {
      entry.reject(new Error("CodeGraph MCP process closed before responding."));
    }
    pending.clear();
    if (!child.killed) child.kill();
  };

  const onAbort = () => cleanup();
  signal?.addEventListener("abort", onAbort, { once: true });

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf-8");
    let newline;
    while ((newline = stdout.indexOf("\n")) !== -1) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;

      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf-8");
  });

  child.on("error", (err) => {
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  });

  child.on("exit", (code) => {
    if (pending.size === 0) return;
    const diagnostic = sanitizeDiagnostic(stderr.trim());
    const msg = diagnostic || `CodeGraph MCP process exited with code ${code}`;
    for (const entry of pending.values()) entry.reject(new Error(msg));
    pending.clear();
  });

  const sendRequest: JsonRpcRequest = (method, params) => {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  };

  const sendNotification = (method: string, params: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };

  try {
    const rootUri = pathToFileURL(cwd).href;
    await sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: cwd.split(/[\\/]/).pop() || cwd }],
      capabilities: {},
      clientInfo: { name: "pi-codegraph", version: "0.1.0" },
    });
    sendNotification("initialized", {});
    return await fn(sendRequest);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    cleanup();
  }
}

export async function callCodeGraphTool(
  name: ToolName,
  params: ToolParams,
  signal?: AbortSignal,
): Promise<string> {
  const projectPath = typeof params.projectPath === "string" ? params.projectPath : undefined;
  const result = await withCodeGraphMcp(projectPath, signal, (request) =>
    request("tools/call", {
      name,
      arguments: params || {},
    })
  );

  const text = (result?.content || [])
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text)
    .join("\n");

  if (result?.isError) throw new Error(text || "CodeGraph tool failed.");
  return text || JSON.stringify(result);
}

export default function codegraphExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    const guidance = [
      "CodeGraph tools are available as codegraph_* Pi tools.",
      "For architecture, flow, where-is-symbol, impact, and codebase navigation questions, use CodeGraph tools directly before grep/read.",
      "Use codegraph_context first for broad questions, codegraph_search for symbol-name lookup, codegraph_files for project structure, codegraph_node for a known symbol, and codegraph_trace for call paths.",
      "If codegraph_search returns no exact result, try codegraph_context or codegraph_files/codegraph_explore before falling back to grep/read; CodeGraph symbol search may miss literal constants or generated names that still exist in source text.",
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
