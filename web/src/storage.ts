// Per-browser conveniences only; every read and write tolerates blocked storage.
export const stored = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};

export const store = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};
