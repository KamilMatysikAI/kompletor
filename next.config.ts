import type { NextConfig } from 'next'

// CSP bez nonce: Next potrzebuje skryptów inline do hydratacji, więc 'unsafe-inline' zostaje
// w script-src; twarde dyrektywy (ramki, base, formularze, object) niczego nie psują. Tryb dev dokłada 'unsafe-eval'
// (React Refresh). Nonce w proxy.ts — kolejny krok, gdy wejdą ekrany z akcjami.
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // pływająca ikona narzędzi Next w trybie dev zasłaniała menu i pola wyboru na telefonie (zrzuty, demo)
  devIndicators: false,
  // zdjęcia produktu idą akcją serwera (do 15 MB każde, razem najwyżej
  // UPLOAD_REQUEST_MAX_BYTES z lib/files/upload-guard.ts = 60 MB). Domyślnie Next tnie ciało akcji na 1 MB, a proxy.ts
  // buforuje najwyżej 10 MB: oba limity nieco ponad łączny limit osłony, żeby za duże żądanie dostało komunikat osłony,
  // nie błąd Next. Spójność pilnuje lib/files/upload-limity.test.ts.
  experimental: {
    serverActions: { bodySizeLimit: '64mb' },
    proxyClientMaxBodySize: '64mb',
  },
  // pdfkit i bwip-js (wydruki) czytają swoje pliki danych z dysku — nie pakować ich bundlerem.
  // xmllint-wasm (walidator XSD FA(3)) uruchamia worker z własnego katalogu (plik .wasm), jak w DewFlow.
  // imapflow (czytnik odbić) ciągnie pino z wątkami roboczymi: też poza bundlerem.
  serverExternalPackages: ['@prisma/client', 'pg', 'pdfkit', 'bwip-js', '@node-rs/argon2', 'xmllint-wasm', 'sharp', 'imapflow'],
  // Fonty wydruków (lib/wydruki/fonty) i schematy XSD FA(3) (lib/ksef/xsd) są czytane przez fs, a worker xmllint-wasm
  // ładuje się z node_modules: dołączyć je do wyjścia standalone (Dockerfile kopiuje tylko .next/standalone).
  // docs/ czyta ekran Pomoc (lib/pomoc/dokumenty.ts), też przez fs.
  outputFileTracingIncludes: {
    '/**': ['./lib/wydruki/fonty/**', './lib/ksef/xsd/**', './node_modules/xmllint-wasm/**/*', './docs/**'],
  },
  // panel z danymi zamówień — bez osadzania w ramkach, bez wycieku adresu w Referer, bez cache pośredników.
  // HSTS pod tym samym warunkiem co prefiks __Host- ciasteczka sesji
  // (lib/auth/sesja-ciasteczko.ts), czyli instalacja po https. Bez includeSubDomains (domena główna bywa osobną stroną)
  // i bez preload. Przeglądarka ignoruje ten nagłówek po http, więc self-host po http nie ucierpi. Warunek liczy się
  // przy budowie (Next zapisuje nagłówki w manifeście), w obrazie zwykle NODE_ENV=production bez COOKIE_SECURE.
  async headers() {
    const https = process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false'
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: CSP },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          ...(https ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }] : []),
        ],
      },
      {
        source: '/((?!_next/static|_next/image).*)',
        headers: [{ key: 'Cache-Control', value: 'private, no-store' }],
      },
    ]
  },
}

export default nextConfig
