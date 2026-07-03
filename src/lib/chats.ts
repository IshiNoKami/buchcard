// Multiple chat sessions persisted in localStorage. Each session keeps its own
// message history so the user can start new chats, switch between old ones and
// delete them. Survives the panel being minimized/closed (state lives here).

export interface ChatMessageStored {
  role: "user" | "assistant";
  content: string;
  summary?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessageStored[];
  createdAt: number;
  updatedAt: number;
}

const CHATS_KEY = "buchcard_chats";
const ACTIVE_KEY = "buchcard_active_chat";

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function getChats(): ChatSession[] {
  try {
    const raw = localStorage.getItem(CHATS_KEY);
    const list = raw ? (JSON.parse(raw) as ChatSession[]) : [];
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function saveChats(chats: ChatSession[]): void {
  localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
}

export function getActiveId(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}

export function setActiveId(id: string): void {
  localStorage.setItem(ACTIVE_KEY, id);
}

/** Derive a short title from the first user message. */
export function titleFrom(messages: ChatMessageStored[]): string {
  const firstUser = messages.find((m) => m.role === "user" && !m.summary);
  if (!firstUser) return "Новый чат";
  const t = firstUser.content.trim().replace(/\s+/g, " ");
  return t.length > 34 ? t.slice(0, 34) + "…" : t;
}

/** Create a fresh empty session, persist it and mark it active. */
export function createChat(): ChatSession {
  const chat: ChatSession = {
    id: uid(),
    title: "Новый чат",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const chats = getChats();
  saveChats([chat, ...chats]);
  setActiveId(chat.id);
  return chat;
}

/** Replace a session's messages (and refresh title/updatedAt). */
export function updateChatMessages(id: string, messages: ChatMessageStored[]): void {
  const chats = getChats();
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return;
  chats[idx] = {
    ...chats[idx],
    messages,
    title: chats[idx].title === "Новый чат" || chats[idx].messages.length === 0
      ? titleFrom(messages)
      : chats[idx].title,
    updatedAt: Date.now(),
  };
  saveChats(chats);
}

export function deleteChat(id: string): void {
  const chats = getChats().filter((c) => c.id !== id);
  saveChats(chats);
  if (getActiveId() === id) {
    if (chats.length > 0) setActiveId(chats[0].id);
    else localStorage.removeItem(ACTIVE_KEY);
  }
}

/** Return the active session, creating a first one if none exist. */
export function getOrCreateActive(): ChatSession {
  const chats = getChats();
  const activeId = getActiveId();
  const active = chats.find((c) => c.id === activeId);
  if (active) return active;
  if (chats.length > 0) {
    setActiveId(chats[0].id);
    return chats[0];
  }
  return createChat();
}
