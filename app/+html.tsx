import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

const base = process.env.EXPO_PUBLIC_BASE_URL ?? '';

export default function Root({ children }: PropsWithChildren) {
  const shareCaptureScript = `(function () {
    try {
      var url = new URL(window.location.href);
      var payload = url.searchParams.get('ort');
      if (!payload) return;
      window.sessionStorage.setItem('creative-cooking-openrouter-share-v1', payload);
      url.searchParams.delete('ort');
      window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
    } catch (error) {
      console.warn('Could not capture shared provider credential', error);
    }
  })();`;
  const themeStartupScript = `(function () {
    try {
      var preference = window.localStorage.getItem('creative-cooking-theme-v1') || 'system';
      var dark = preference === 'dark' || (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      var scheme = dark ? 'dark' : 'light';
      document.documentElement.dataset.theme = scheme;
      document.documentElement.style.colorScheme = scheme;
      document.documentElement.style.backgroundColor = dark ? '#0b1220' : '#f8fafc';
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', dark ? '#0f172a' : '#172033');
    } catch (error) {
      console.warn('Could not apply saved theme preference', error);
    }
  })();`;
  const serviceWorkerScript = `if ('serviceWorker' in navigator) { window.addEventListener('load', function () { navigator.serviceWorker.register('${base}/sw.js', { scope: '${base || ''}/' }).catch(function (error) { console.warn('Service worker registration failed', error); }); }); }`;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover" />
        <meta name="referrer" content="no-referrer" />
        <meta name="theme-color" content="#172033" />
        <meta name="color-scheme" content="light dark" />
        <meta name="description" content="A local-first creative cooking assistant for your pantry." />
        <script dangerouslySetInnerHTML={{ __html: themeStartupScript }} />
        <script dangerouslySetInnerHTML={{ __html: shareCaptureScript }} />
        <link rel="manifest" href={`${base}/manifest.json`} />
        <link rel="apple-touch-icon" href={`${base}/icon-192.png`} />
        <ScrollViewStyleReset />
        <script dangerouslySetInnerHTML={{ __html: serviceWorkerScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
