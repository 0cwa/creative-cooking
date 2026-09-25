import { useEffect, useMemo, useState } from 'react';
import { Appearance, Platform, useColorScheme } from 'react-native';
import type { ThemePreference } from '@/domain/types';
import { useAppState } from '@/state/AppState';
import { setActiveColorScheme, type ResolvedColorScheme } from './StyleSheet';

const WEB_THEME_KEY = 'creative-cooking-theme-v1';

export type AppTheme = {
  scheme: ResolvedColorScheme;
  preference: ThemePreference;
  colors: {
    background: string;
    surface: string;
    text: string;
    muted: string;
    subdued: string;
    border: string;
    control: string;
    primary: string;
    primaryText: string;
    placeholder: string;
    chrome: string;
  };
};

const lightTheme: Omit<AppTheme, 'preference'> = {
  scheme: 'light',
  colors: {
    background: '#f8fafc',
    surface: '#ffffff',
    text: '#172033',
    muted: '#64748b',
    subdued: '#94a3b8',
    border: '#e2e8f0',
    control: '#f1f5f9',
    primary: '#172033',
    primaryText: '#ffffff',
    placeholder: '#94a3b8',
    chrome: '#172033'
  }
};

const darkTheme: Omit<AppTheme, 'preference'> = {
  scheme: 'dark',
  colors: {
    background: '#0b1220',
    surface: '#111827',
    text: '#f8fafc',
    muted: '#cbd5e1',
    subdued: '#94a3b8',
    border: '#334155',
    control: '#1e293b',
    primary: '#334155',
    primaryText: '#f8fafc',
    placeholder: '#94a3b8',
    chrome: '#0f172a'
  }
};

export function resolveColorScheme(
  preference: ThemePreference,
  systemScheme: 'light' | 'dark' | 'unspecified' | null | undefined
): ResolvedColorScheme {
  if (preference === 'light' || preference === 'dark') return preference;
  return systemScheme === 'dark' ? 'dark' : 'light';
}

export function useSystemColorScheme(): ResolvedColorScheme {
  const nativeScheme = useColorScheme();
  const [webScheme, setWebScheme] = useState<ResolvedColorScheme>(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setWebScheme(query.matches ? 'dark' : 'light');
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  if (Platform.OS === 'web') return webScheme;
  return nativeScheme === 'dark' ? 'dark' : 'light';
}

export function useAppTheme(): AppTheme {
  const app = useAppState();
  const systemScheme = useSystemColorScheme();
  const preference = app.settings.theme;
  const scheme = resolveColorScheme(preference, systemScheme);
  setActiveColorScheme(scheme);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      Appearance.setColorScheme(preference === 'system' ? 'unspecified' : preference);
      return;
    }

    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = scheme;
    document.documentElement.style.colorScheme = scheme;
    document.documentElement.style.backgroundColor = scheme === 'dark' ? '#0b1220' : '#f8fafc';
    if (document.body) document.body.style.backgroundColor = scheme === 'dark' ? '#0b1220' : '#f8fafc';

    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute('content', scheme === 'dark' ? '#0f172a' : '#172033');

    try {
      window.localStorage.setItem(WEB_THEME_KEY, preference);
    } catch {
      // The main preference still persists with the rest of local app state.
    }
  }, [preference, scheme]);

  return useMemo(
    () => ({ ...(scheme === 'dark' ? darkTheme : lightTheme), preference }),
    [preference, scheme]
  );
}
