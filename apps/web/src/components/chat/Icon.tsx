// Icons copied from docs/mockups/chat.html <symbol> defs (stroke icons, currentColor).
import type { ReactElement } from "react";

export type IconName = "menu" | "plus" | "search" | "dots" | "chev" | "chevr" | "check" | "pin" | "edit" | "copy" | "refresh" | "fork" | "clip" | "up" | "send" | "steer" | "down" | "stop" | "x" | "file" | "image" | "code" | "chat" | "grid" | "gear" | "trash" | "archive" | "export" | "upload" | "camera" | "info" | "alert" | "spark" | "term" | "bulb" | "book" | "server";

const PATHS: Record<IconName, string> = {
  "menu": '<path d="M4 7h16M4 12h16M4 17h16"/>',
  "plus": '<path d="M12 5v14M5 12h14"/>',
  "search": '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>',
  "dots": '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  "chev": '<path d="M6 9l6 6 6-6"/>',
  "chevr": '<path d="M9 6l6 6-6 6"/>',
  "check": '<path d="M5 12.5l4.5 4.5L19 7"/>',
  "pin": '<path d="M9 4h6l-1 5 3 3H7l3-3-1-5zM12 12v8"/>',
  "edit": '<path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/>',
  "copy": '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  "refresh": '<path d="M20 12a8 8 0 1 1-2.3-5.6L20 9M20 4v5h-5"/>',
  "fork": '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 4-6 3-12 8"/>',
  "clip": '<path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/>',
  "up": '<path d="M12 19V5M6 11l6-6 6 6"/>',
  "send": '<path d="M7 4.5v15L19 12z" fill="currentColor"/>',
  "steer": '<path d="M5 20v-8a4 4 0 0 1 4-4h10M15 4l4 4-4 4"/>',
  "down": '<path d="M12 5v14M6 13l6 6 6-6"/>',
  "stop": '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  "x": '<path d="M6 6l12 12M18 6L6 18"/>',
  "file": '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  "image": '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 9"/>',
  "code": '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  "chat": '<path d="M4 5h16v11H9l-5 4z"/>',
  "grid": '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  "gear": '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/>',
  "trash": '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  "archive": '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8M10 12h4"/>',
  "export": '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  "upload": '<path d="M12 16V4M7 9l5-5 5 5M4 16v4h16v-4"/>',
  "camera": '<rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="12" cy="13.5" r="3.5"/><path d="M8 7l1.5-3h5L16 7"/>',
  "info": '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
  "alert": '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.01"/>',
  "spark": '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>',
  "term": '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  "bulb": '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  "book": '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5zM4 19a2 2 0 0 1 2-2h13"/>',
  "server": '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>',
};

/** Renders one icon. The inner markup is trusted (it is our own static SVG, not user data). */
export function Icon({ name, className = "i" }: { name: IconName; className?: string }): ReactElement {
  return <svg className={className} aria-hidden="true" viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: PATHS[name] }} />;
}
