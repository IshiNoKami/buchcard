// Ollama's API doesn't expose which models are usable by this assistant — a model
// may be paid-only (Cloud subscription) or simply not support tool calling
// (e.g. gemma3). We learn it reactively: when a model errors on use, we remember
// it here and hide it from the picker. Persisted in localStorage.

const KEY = "ollamaPaidModels";

export function getPaidModels(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function addPaidModel(model: string): string[] {
  const cur = getPaidModels();
  if (!model || cur.includes(model)) return cur;
  const next = [...cur, model];
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function clearPaidModels(): void {
  localStorage.removeItem(KEY);
}
