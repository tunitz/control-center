#!/usr/bin/env bun
// Scripted stand-in for `pi --mode rpc`. Event shapes follow Pi 1.1.0 docs/json.md and
// the T0 spike logs. Scenario is chosen by the prompt text:
//   ERR      assistant ends with stopReason "error"
//   SLOW     streams a partial, waits for abort, ends with stopReason "aborted"
//   CONFIRM  asks extension_ui_request confirm, then reports the answer
//   TODO     emits a todo_write tool result with details.todos
//   U2028    text containing raw U+2028 / U+2029
//   CRASH    exits the process mid-run (exit code 3)
//   (other)  streams "OK" and stops
// Never reads secrets; `get_state` reports env variable NAMES only (for leak tests).

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sessionDir = flag("--session-dir") ?? "/tmp";
let sessionFile: string | undefined = args.includes("--no-session")
  ? undefined
  : (flag("--session") ?? `${sessionDir}/fake-${process.pid}.jsonl`);
let model = { provider: "deepseek", id: "deepseek-flash" };
let thinking = "off";
const modelsAvail = [
  { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek Flash" },
  { provider: "deepseek", id: "deepseek-pro", name: "DeepSeek Pro" },
];

let busy = false;
let abortRequested = false;
let abortNow: (() => void) | null = null;
const pendingUi = new Map<string, (resp: any) => void>();

function out(o: unknown) {
  process.stdout.write(JSON.stringify(o) + "\n");
}
function ok(command: string, id: string, data?: unknown) {
  out({ id, type: "response", command, success: true, ...(data !== undefined ? { data } : {}) });
}
function fail(command: string, id: string, error: string) {
  out({ id, type: "response", command, success: false, error });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assistant(text: string, stopReason: string, errorMessage?: string) {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "fake",
    provider: model.provider,
    model: model.id,
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: 0 } },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function settle(msgs: any[], stopReason: string) {
  const last = msgs[msgs.length - 1];
  out({ type: "turn_end", message: last, toolResults: [] });
  out({ type: "agent_end", messages: msgs, willRetry: false });
  out({ type: "agent_settled", aborted: stopReason === "aborted" });
  busy = false;
}

async function runPrompt(message: string) {
  busy = true;
  abortRequested = false;
  const userMsg = { role: "user", content: message, timestamp: Date.now() };
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  out({ type: "message_start", message: userMsg });
  out({ type: "message_end", message: userMsg });

  if (message.includes("CRASH")) {
    out({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });
    process.exit(3);
  }

  const start = { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } };
  out(start);

  const streamText = (text: string) => {
    out({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    out({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
  };

  if (message.includes("ERR")) {
    const msg = assistant("", "error", "boom: provider down");
    out({ type: "message_end", message: msg });
    settle([userMsg, msg], "error");
    return;
  }

  if (message.includes("SLOW")) {
    streamText("partial");
    await new Promise<void>((resolve) => {
      abortNow = resolve;
      if (abortRequested) resolve();
    });
    abortNow = null;
    const msg = assistant("partial", "aborted", "Request was aborted");
    out({ type: "message_end", message: msg });
    settle([userMsg, msg], "aborted");
    return;
  }

  if (message.includes("CONFIRM")) {
    out({
      type: "extension_ui_request",
      id: "ui-1",
      method: "confirm",
      title: "Allow command?",
      message: "rm -rf scratch",
      timeout: 120000,
    });
    const resp: any = await new Promise((resolve) => pendingUi.set("ui-1", resolve));
    const confirmed = resp.confirmed === true;
    out({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "rm -rf scratch" } });
    out({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: confirmed ? "removed" : "blocked by user" }], details: {} },
      isError: !confirmed,
      durationMs: 5,
    });
    const msg = assistant(`got:${confirmed}`, "stop");
    streamText(`got:${confirmed}`);
    out({ type: "message_end", message: msg });
    settle([userMsg, msg], "stop");
    return;
  }

  if (message.includes("TODO")) {
    const todos = [
      { id: "1", content: "plan", status: "completed" },
      { id: "2", content: "do", status: "in_progress" },
    ];
    out({ type: "tool_execution_start", toolCallId: "call-t", toolName: "todo_write", args: { todos } });
    out({
      type: "tool_execution_end",
      toolCallId: "call-t",
      toolName: "todo_write",
      result: { content: [{ type: "text", text: "ok" }], details: { todos } },
      isError: false,
      durationMs: 1,
    });
  }

  const text = message.includes("U2028") ? "a\u2028b\u2029c" : "OK";
  streamText(text);
  const msg = assistant(text, "stop");
  out({ type: "message_end", message: msg });
  settle([userMsg, msg], "stop");
}

async function handle(cmd: any) {
  const id: string = cmd.id ?? "";
  switch (cmd.type) {
    case "get_state":
      ok("get_state", id, {
        model,
        thinkingLevel: thinking,
        isStreaming: busy,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        sessionFile,
        sessionId: sessionFile ? sessionFile.split("/").pop() : undefined,
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
        pid: process.pid,
        envKeys: Object.keys(process.env).sort(),
      });
      return;
    case "set_model": {
      const found = modelsAvail.find((m) => m.provider === cmd.provider && m.id === cmd.modelId);
      if (!found) return fail("set_model", id, `Model not found: ${cmd.provider}/${cmd.modelId}`);
      model = { provider: found.provider, id: found.id };
      ok("set_model", id, model);
      return;
    }
    case "set_thinking_level":
      thinking = cmd.level;
      ok("set_thinking_level", id);
      return;
    case "get_available_thinking_levels":
      ok("get_available_thinking_levels", id, { levels: ["off", "low", "high", "max"] });
      return;
    case "get_available_models":
      ok("get_available_models", id, { models: modelsAvail });
      return;
    case "prompt": {
      const message = typeof cmd.message === "string" ? cmd.message : JSON.stringify(cmd.message);
      if (message.startsWith("/cc-ping")) {
        ok("prompt", id, { disposition: "handled" });
        out({ type: "extension_ui_request", id: "n-1", method: "notify", message: "pong", notifyType: "info" });
        return;
      }
      if (busy) {
        if (!cmd.streamingBehavior) return fail("prompt", id, "Agent is already processing.");
        ok("prompt", id, { disposition: "queued" });
        return;
      }
      ok("prompt", id, { disposition: "started" });
      void runPrompt(message);
      return;
    }
    case "steer":
    case "follow_up":
      ok(cmd.type, id, { disposition: "queued" });
      return;
    case "abort":
      if (busy) {
        abortRequested = true;
        abortNow?.();
        while (busy) await sleep(5);
      }
      ok("abort", id);
      return;
    case "extension_ui_response": {
      const resolve = pendingUi.get(cmd.id);
      pendingUi.delete(cmd.id);
      resolve?.(cmd);
      return;
    }
    case "get_messages":
      ok("get_messages", id, { messages: [] });
      return;
    case "get_entries":
      ok("get_entries", id, { entries: [] });
      return;
    case "get_commands":
      ok("get_commands", id, {
        commands: [{ name: "cc-ping", description: "ping", source: "extension", sourceInfo: {} }],
      });
      return;
    case "switch_session":
      if (typeof cmd.sessionPath === "string") sessionFile = cmd.sessionPath;
      ok("switch_session", id, { cancelled: false });
      return;
    case "new_session":
    case "set_session_name":
    case "compact":
    case "set_auto_compaction":
    case "set_auto_retry":
    case "set_steering_mode":
    case "set_follow_up_mode":
      ok(cmd.type, id, {});
      return;
    default:
      fail(cmd.type ?? "unknown", id, `Unknown command: ${cmd.type}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let idx: number;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    void handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
