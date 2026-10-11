// Typechecked by Pi itself at load time (it imports Pi packages not installed in this repo). Live-verified with real Pi.
// cc-todo: todo_write tool keeping full list state in tool-result details, mirrored to a widget.
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Status = "pending" | "in_progress" | "completed";
interface Item { id: string; content: string; status: Status }
interface Details { todos: Item[] }

const Params = Type.Object({
  todos: Type.Array(
    Type.Object({
      id: Type.String(),
      content: Type.String(),
      status: StringEnum(["pending", "in_progress", "completed"] as const),
    }),
    { description: "Full replacement list of todos" },
  ),
});

const render = (todos: Item[]): string[] =>
  todos.length === 0
    ? ["(no todos)"]
    : todos.map((t) => {
        const mark = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]";
        return `${mark} ${t.id}: ${t.content}`;
      });

export default function (pi: ExtensionAPI) {
  let todos: Item[] = [];

  // Rebuild state from the latest todo_write result on the current branch.
  const reconstruct = (ctx: ExtensionContext) => {
    todos = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg: any = entry.message;
      if (msg.role === "toolResult" && msg.toolName === "todo_write" && msg.details) {
        todos = (msg.details as Details).todos ?? [];
      }
    }
    ctx.ui.setWidget("cc-todo", render(todos));
  };
  pi.on("session_start", async (_e, ctx) => reconstruct(ctx));
  pi.on("session_tree", async (_e, ctx) => reconstruct(ctx));

  pi.registerTool({
    name: "todo_write",
    label: "Todo Write",
    description: "Replace the whole todo list. Pass every item with id, content, and status (pending|in_progress|completed).",
    parameters: Params,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      todos = params.todos.map((t: any) => ({ id: t.id, content: t.content, status: t.status }));
      ctx.ui.setWidget("cc-todo", render(todos));
      const details: Details = { todos: [...todos] };
      return {
        content: [{ type: "text", text: `Todo list updated (${todos.length} items):\n${render(todos).join("\n")}` }],
        details,
      };
    },
  });
}
