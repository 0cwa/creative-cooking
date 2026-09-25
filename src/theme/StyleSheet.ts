import { StyleSheet as NativeStyleSheet, type ImageStyle, type TextStyle, type ViewStyle } from 'react-native';

export type ResolvedColorScheme = 'light' | 'dark';

let activeColorScheme: ResolvedColorScheme = 'light';

type NamedStyles<T> = { [P in keyof T]: ViewStyle | TextStyle | ImageStyle };

const textColors: Record<string, string> = {
  '#172033': '#f8fafc',
  '#334155': '#e2e8f0',
  '#475569': '#cbd5e1',
  '#526176': '#cbd5e1',
  '#64748b': '#94a3b8',
  '#94a3b8': '#94a3b8',
  '#cbd5e1': '#475569',
  '#991b1b': '#fecaca',
  '#9a3412': '#fdba74',
  '#7c2d12': '#fed7aa',
  '#92400e': '#fbbf24',
  '#b45309': '#fbbf24',
  '#b91c1c': '#fca5a5',
  '#166534': '#86efac',
  '#15803d': '#86efac',
  '#14532d': '#86efac',
  '#1d4ed8': '#93c5fd',
  '#d97706': '#fbbf24',
  '#f59e0b': '#fbbf24',
  '#ffffff': '#f8fafc',
  '#fff': '#f8fafc',
  'white': '#f8fafc'
};

const backgroundColors: Record<string, string> = {
  '#f8fafc': '#0b1220',
  '#ffffff': '#111827',
  '#fff': '#111827',
  'white': '#111827',
  '#f1f5f9': '#1e293b',
  '#e2e8f0': '#263449',
  '#eef2f7': '#1e293b',
  '#fbfefb': '#111827',
  '#fff8ed': '#111827',
  '#fff7ed': '#2b190f',
  '#fffbeb': '#2a210d',
  '#f0fdf4': '#10251a',
  '#ecfdf5': '#10251a',
  '#dcfce7': '#14532d',
  '#fee2e2': '#3f1d1d',
  '#172033': '#334155',
  '#334155': '#475569',
  '#14532d': '#166534',
  '#15803d': '#166534',
  '#166534': '#166534',
  '#b91c1c': '#7f1d1d',
  '#d97706': '#b45309',
  '#f59e0b': '#d97706',
  '#cbd5e1': '#475569',
  '#bbf7d0': '#14532d',
  '#a7f3d0': '#14532d',
  '#fed7aa': '#7c2d12',
  '#fdba74': '#7c2d12',
  '#fde68a': '#713f12',
  '#1d4ed8': '#1e40af',
  'rgba(15,23,42,0.35)': 'rgba(0,0,0,0.62)'
};

const borderColors: Record<string, string> = {
  '#e2e8f0': '#334155',
  '#cbd5e1': '#475569',
  '#dbe4dc': '#334155',
  '#dbe4ee': '#334155',
  '#bbf7d0': '#166534',
  '#a7f3d0': '#166534',
  '#fed7aa': '#9a3412',
  '#fdba74': '#9a3412',
  '#fde68a': '#854d0e',
  '#fee2e2': '#7f1d1d',
  '#172033': '#64748b',
  '#334155': '#64748b'
};

function normalizeColor(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

function darkColor(property: string, value: string): string {
  const normalized = normalizeColor(value);
  if (property === 'color') return textColors[normalized] ?? value;
  if (property.toLowerCase().includes('border') && property.endsWith('Color')) {
    return borderColors[normalized] ?? backgroundColors[normalized] ?? value;
  }
  if (property === 'shadowColor') return normalized === '#0f172a' ? '#000000' : value;
  if (property.endsWith('Color')) return backgroundColors[normalized] ?? textColors[normalized] ?? value;
  return value;
}

function makeDarkStyle(style: ViewStyle | TextStyle | ImageStyle): ViewStyle | TextStyle | ImageStyle {
  const result: Record<string, unknown> = { ...style };
  for (const [property, value] of Object.entries(result)) {
    if (typeof value === 'string' && property.endsWith('Color')) {
      result[property] = darkColor(property, value);
    }
  }
  return result as ViewStyle | TextStyle | ImageStyle;
}

function currentColorScheme(): ResolvedColorScheme {
  if (typeof document !== 'undefined') {
    const documentScheme = document.documentElement.dataset.theme;
    if (documentScheme === 'light' || documentScheme === 'dark') return documentScheme;
  }
  return activeColorScheme;
}

export function setActiveColorScheme(scheme: ResolvedColorScheme): void {
  activeColorScheme = scheme;
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = scheme;
}

export function themeColor(color: string, property = 'color'): string {
  return currentColorScheme() === 'dark' ? darkColor(property, color) : color;
}

export const StyleSheet = {
  create<T extends NamedStyles<T> | NamedStyles<any>>(styles: T & NamedStyles<any>): T {
    // React Native Web mutates definitions while compiling them, so build the
    // alternate palette before either set is registered.
    const lightDefinitions = Object.fromEntries(
      Object.entries(styles).map(([name, style]) => [name, { ...(style as ViewStyle | TextStyle | ImageStyle) }])
    ) as T & NamedStyles<any>;
    const darkDefinitions = Object.fromEntries(
      Object.entries(styles).map(([name, style]) => [name, makeDarkStyle(style as ViewStyle | TextStyle | ImageStyle)])
    ) as T & NamedStyles<any>;
    const lightStyles = NativeStyleSheet.create(lightDefinitions) as T;
    const darkStyles = NativeStyleSheet.create(darkDefinitions) as T;

    return new Proxy(lightStyles as object, {
      get(_target, property, receiver) {
        const source = currentColorScheme() === 'dark' ? darkStyles : lightStyles;
        return Reflect.get(source as object, property, receiver);
      }
    }) as T;
  }
};
