/** Colour themes. A theme only overrides design tokens (see styles.css and docs/ui-guidelines.md). */
// Picker order: dark, then light. Both are colourless; a saved theme that no longer exists falls back to Mono.
export const THEMES = [
  { id: 'mono', name: 'Mono', base: '#000000' },
  { id: 'onyx', name: 'Onyx', base: '#f2f2f7' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

export const DEFAULT_THEME: ThemeId = 'mono';

const KEY = 'ytc-theme';

export function loadTheme(): ThemeId {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.some((t) => t.id === v) ? (v as ThemeId) : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(id: ThemeId): void {
  document.documentElement.dataset.theme = id;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', THEMES.find((t) => t.id === id)?.base ?? THEMES[0].base);
}

export function saveTheme(id: ThemeId): void {
  applyTheme(id);
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Storage blocked: the theme still applies for this visit.
  }
}
