import { createContext, useContext, useEffect, useMemo, useState } from "react";

export type Theme = "dark" | "light" | "midnight";

export const THEMES: { id: Theme; label: string; dot: string }[] = [
  { id: "dark",     label: "Тёмная",    dot: "#1e2235" },
  { id: "light",    label: "Светлая",   dot: "#f0f4ff" },
  { id: "midnight", label: "Midnight",  dot: "#12102a" },
];

interface ThemeCtx { theme: Theme; setTheme: (t: Theme) => void; }
const Ctx = createContext<ThemeCtx>({ theme: "dark", setTheme: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem("buchcard-theme") as Theme) ?? "dark"
  );

  useEffect(() => {
    document.documentElement.className = theme;
    localStorage.setItem("buchcard-theme", theme);
  }, [theme]);

  return (
    <Ctx.Provider value={{ theme, setTheme: setThemeState }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTheme() { return useContext(Ctx); }

export function useChartColors() {
  const { theme } = useTheme();
  return useMemo(() => {
    const s   = getComputedStyle(document.documentElement);
    const hsl = (v: string) => `hsl(${s.getPropertyValue(v).trim()})`;
    return {
      tooltipBg:     hsl("--card"),
      tooltipBorder: hsl("--border"),
      tooltipText:   hsl("--card-foreground"),
      tooltipMuted:  hsl("--muted-foreground"),
      grid:          hsl("--border"),
      tick:          hsl("--muted-foreground"),
      primary:       hsl("--primary"),
    };
  }, [theme]);
}
