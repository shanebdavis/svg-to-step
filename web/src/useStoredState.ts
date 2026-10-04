import { useEffect, useState } from "react";

/** useState that survives reloads. Storage can be unavailable, so failures fall back to defaults. */
export function useStoredState<T extends object>(key: string, defaults: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      return { ...defaults, ...JSON.parse(localStorage.getItem(key) ?? "{}") };
    } catch {
      return defaults;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Private browsing or blocked storage: settings just won't persist.
    }
  }, [key, value]);
  return [value, setValue] as const;
}
