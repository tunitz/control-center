/** Remembers the last opened chat session so the Chat tab can return to it. */
export const LAST_CHAT_KEY = "cc-chat-last";

type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Hash the Chat tab should go to from outside chat: the stored session, or the list. */
export function lastChatHash(store: KV): string {
  let id: string | null = null;
  try { id = store.getItem(LAST_CHAT_KEY); } catch { /* storage unavailable */ }
  return id ? `#/chat/${encodeURIComponent(id)}` : "#/chat";
}

/** Store the session currently shown. */
export function rememberChat(store: KV, id: string): void {
  try { store.setItem(LAST_CHAT_KEY, id); } catch { /* ignore */ }
}

/** Clear the stored session. With an id, clears only when that id is the stored one
 *  (used when a session is deleted or found missing). Without an id, always clears. */
export function forgetChat(store: KV, id?: string): void {
  try {
    if (id !== undefined && store.getItem(LAST_CHAT_KEY) !== id) return;
    store.removeItem(LAST_CHAT_KEY);
  } catch { /* ignore */ }
}
