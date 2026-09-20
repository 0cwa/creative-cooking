import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

const base = process.env.EXPO_PUBLIC_BASE_URL ?? '';

export default function Root({ children }: PropsWithChildren) {
  const serviceWorkerScript = `if ('serviceWorker' in navigator) { window.addEventListener('load', function () { navigator.serviceWorker.register('${base}/sw.js', { scope: '${base || ''}/' }).catch(function (error) { console.warn('Service worker registration failed', error); }); }); }`;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover" />
        <meta name="theme-color" content="#172033" />
        <meta name="description" content="A local-first creative cooking assistant for your pantry." />
        <link rel="manifest" href={`${base}/manifest.json`} />
        <link rel="apple-touch-icon" href={`${base}/icon-192.png`} />
        <ScrollViewStyleReset />
        <script dangerouslySetInnerHTML={{ __html: serviceWorkerScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
