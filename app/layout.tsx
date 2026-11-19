import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import { MOTYW_CIASTECZKO, motywZ } from '@/lib/panel/motyw'
import { Bricolage_Grotesque, IBM_Plex_Mono, Public_Sans } from 'next/font/google'
// kolejność ma znaczenie — tokeny, potem klasy panelu (aliasy tokenów), potem komponenty app/ui
import './ui/tokeny.css'
import './panel.css'
import './ui/komponenty.css'

// Fonty pobierane przy budowaniu i serwowane z naszej domeny (przeglądarka nie łączy się z Google).
const display = Bricolage_Grotesque({ subsets: ['latin', 'latin-ext'], weight: ['500', '700'], variable: '--font-bricolage', display: 'swap' })
const body = Public_Sans({ subsets: ['latin', 'latin-ext'], weight: ['400', '500', '600', '700'], variable: '--font-public-sans', display: 'swap' })
const mono = IBM_Plex_Mono({ subsets: ['latin', 'latin-ext'], weight: ['400', '600'], variable: '--font-plex-mono', display: 'swap' })

export const metadata = { title: { default: 'Kompletor', template: '%s · Kompletor' }, robots: { index: false, follow: false } }

export default async function RootLayout({ children }: { children: ReactNode }) {
  // motyw z ciasteczka od razu w HTML z serwera (bez mignięcia jasnym tłem przy ciemnym motywie)
  const motyw = motywZ((await cookies()).get(MOTYW_CIASTECZKO)?.value)
  return (
    <html lang="pl" data-motyw={motyw} className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  )
}
