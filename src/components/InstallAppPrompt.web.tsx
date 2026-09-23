import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { usePathname } from 'expo-router';
import { useAppState } from '@/state/AppState';

const DISMISSED_KEY = 'creative-cooking-install-prompt-dismissed-v1';

type DeferredInstallPrompt = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

type AppleInstallMode = 'ios-safari' | 'ios-other' | 'mac-safari';

function isStandalone(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia('(display-mode: standalone)').matches || navigatorWithStandalone.standalone === true;
}

function appleInstallMode(): AppleInstallMode | null {
  if (typeof navigator === 'undefined') return null;
  const userAgent = navigator.userAgent;
  const isIpadOs = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const isIos = /iPhone|iPad|iPod/i.test(userAgent) || isIpadOs;
  const isSafari = /Safari/i.test(userAgent) && !/(CriOS|Chrome|Edg|FxiOS|OPiOS)/i.test(userAgent);

  if (isIos) return isSafari ? 'ios-safari' : 'ios-other';
  if (isSafari && /Macintosh/i.test(userAgent)) return 'mac-safari';
  return null;
}

function wasDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberDismissal(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // This preference is best-effort. Failing to persist it should not break the app.
  }
}

export function InstallAppPrompt() {
  const app = useAppState();
  const pathname = usePathname();
  const appleMode = useMemo(appleInstallMode, []);
  const [deferredPrompt, setDeferredPrompt] = useState<DeferredInstallPrompt | null>(null);
  const [preferenceLoaded, setPreferenceLoaded] = useState(false);
  const [suppressed, setSuppressed] = useState(false);
  const [ready, setReady] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [pantryBottomInset, setPantryBottomInset] = useState<number | null>(null);

  const engaged = app.pantry.length > 0
    || app.recipes.length > 0
    || app.chatMessages.some((message) => message.role === 'user')
    || app.chatHistory.some((conversation) => conversation.messages.some((message) => message.role === 'user'));

  useEffect(() => {
    setSuppressed(isStandalone() || wasDismissed());
    setPreferenceLoaded(true);
  }, []);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as DeferredInstallPrompt);
    };
    const onInstalled = () => {
      rememberDismissal();
      setSuppressed(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!preferenceLoaded || suppressed || !app.hydrated || !engaged || (!deferredPrompt && !appleMode)) {
      setReady(false);
      return;
    }

    const timer = window.setTimeout(() => setReady(true), 1200);
    return () => window.clearTimeout(timer);
  }, [app.hydrated, appleMode, deferredPrompt, engaged, preferenceLoaded, suppressed]);

  useEffect(() => {
    if (pathname !== '/') {
      setPantryBottomInset(null);
      return;
    }

    const updateInset = () => {
      const composer = document.querySelector('[data-testid="pantry-composer"]');
      if (!(composer instanceof HTMLElement)) {
        setPantryBottomInset(null);
        return;
      }
      const composerTop = composer.getBoundingClientRect().top;
      setPantryBottomInset(Math.max(72, window.innerHeight - composerTop + 10));
    };

    updateInset();
    window.addEventListener('resize', updateInset);

    const composer = document.querySelector('[data-testid="pantry-composer"]');
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateInset);
    if (composer) observer?.observe(composer);

    return () => {
      window.removeEventListener('resize', updateInset);
      observer?.disconnect();
    };
  }, [pathname]);

  const dismiss = () => {
    rememberDismissal();
    setSuppressed(true);
  };

  const install = async () => {
    if (!deferredPrompt) {
      setShowInstructions(true);
      return;
    }

    const prompt = deferredPrompt;
    setDeferredPrompt(null);
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      rememberDismissal();
      setSuppressed(true);
      if (choice.outcome === 'accepted') setShowInstructions(false);
    } catch {
      // The browser can invalidate a deferred prompt. Hide this session rather than nagging.
      setReady(false);
    }
  };

  if (!ready || pathname === '/settings') return null;

  const instruction = appleMode === 'ios-safari'
    ? 'In Safari, tap Share, choose Add to Home Screen, turn on Open as Web App, then tap Add.'
    : appleMode === 'ios-other'
      ? 'Open this page in Safari, then use Share → Add to Home Screen and turn on Open as Web App.'
      : 'In Safari, use Share → Add to Dock (or File → Add to Dock).';

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.layer,
        pathname === '/' && pantryBottomInset !== null ? { bottom: pantryBottomInset } : null
      ]}
    >
      <View accessibilityLiveRegion="polite" testID="install-app-prompt" style={styles.card}>
        <View style={styles.copy}>
          <Text style={styles.eyebrow}>APP TIP</Text>
          <Text style={styles.title}>Install Creative Cooking</Text>
          <Text style={styles.body}>
            Open it like an app for quicker access. Your pantry, chats, and saved recipes stay available offline.
          </Text>
          {showInstructions ? <Text style={styles.instructions}>{instruction}</Text> : null}
        </View>
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={deferredPrompt ? 'Install Creative Cooking' : 'Show install instructions'}
            onPress={() => void install()}
            style={({ pressed }) => [styles.installButton, pressed && styles.pressed]}
          >
            <Text style={styles.installButtonText}>{deferredPrompt ? 'Install' : 'How to install'}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss install tip"
            onPress={dismiss}
            style={({ pressed }) => [styles.dismissButton, pressed && styles.pressed]}
          >
            <Text style={styles.dismissButtonText}>Not now</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 72,
    zIndex: 1000,
    alignItems: 'center'
  },
  card: {
    width: '100%',
    maxWidth: 460,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#dbe4ee',
    backgroundColor: '#ffffff',
    padding: 15,
    gap: 13,
    shadowColor: '#0f172a',
    shadowOpacity: 0.14,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8
  },
  copy: {
    gap: 4
  },
  eyebrow: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.35
  },
  title: {
    color: '#172033',
    fontSize: 18,
    lineHeight: 23,
    fontWeight: '800'
  },
  body: {
    color: '#526176',
    fontSize: 13.5,
    lineHeight: 19
  },
  instructions: {
    marginTop: 5,
    borderRadius: 11,
    backgroundColor: '#f1f5f9',
    color: '#334155',
    fontSize: 12.5,
    lineHeight: 18,
    paddingHorizontal: 10,
    paddingVertical: 8
  },
  actions: {
    flexDirection: 'row',
    gap: 9,
    flexWrap: 'wrap'
  },
  installButton: {
    minHeight: 40,
    borderRadius: 12,
    backgroundColor: '#172033',
    paddingHorizontal: 16,
    paddingVertical: 9,
    alignItems: 'center',
    justifyContent: 'center'
  },
  installButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800'
  },
  dismissButton: {
    minHeight: 40,
    borderRadius: 12,
    backgroundColor: '#eef2f7',
    paddingHorizontal: 15,
    paddingVertical: 9,
    alignItems: 'center',
    justifyContent: 'center'
  },
  dismissButtonText: {
    color: '#475569',
    fontSize: 14,
    fontWeight: '700'
  },
  pressed: {
    opacity: 0.76
  }
});
