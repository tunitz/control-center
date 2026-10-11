import { useState } from "react";
import { Icon } from "./Icon";
import { todoSummary } from "../../chat/pi";
import type { TodoItem } from "../../chat/types";

/** Pi's task list for this turn. Open while work remains; folded once everything is done. */
export function Todos({ id, todos }: { id: string; todos: TodoItem[] | null | undefined }) {
  const sum = todoSummary(todos);
  const [open, setOpen] = useState<boolean | null>(null);
  if (!sum || !todos) return null;
  const isOpen = open ?? !sum.done;
  return (
    <div className="fold-wrap todos">
      <button type="button" className="fold" aria-expanded={isOpen} aria-controls={`todos-${id}`} onClick={() => setOpen(!isOpen)}>
        <Icon name="chevr" className="chev" />
        <Icon name="check" className="i sm" />
        <span className="tname">Tasks</span>
        <span className="lbl">{sum.label}</span>
      </button>
      {isOpen && (
        <ul className="todo-list" id={`todos-${id}`}>
          {todos.map(t => (
            <li key={t.id} className={`todo ${t.status}`}>
              <span className="todo-mark" aria-hidden="true" />
              <span className="todo-txt">{t.content}</span>
              <span className="sr">{t.status === "completed" ? "done" : t.status === "in_progress" ? "in progress" : "to do"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
