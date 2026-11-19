// Ustawienia → Integracje i agenci AI → Integracje (R13 z przeglądu TwojOMS): wszystkie połączenia firmy na
// jednej liście ze stanem i jednym przyciskiem do obecnej podstrony (kanały, przewoźnicy, dokumenty sprzedaży, poczta,
// agenci AI, klucze API). Ekran tylko czyta bazę (`lib/panel/integracje.ts`): bez wywołań zewnętrznych przy wejściu
// i bez żadnego zapisu. Logo z plików w `loga/` (Simple Icons, CC0, nota w THIRD_PARTY_NOTICES.md); marka bez pliku
// dostaje ikonę rodzaju, nie wymyślone logo. Tylko z uprawnieniem `ustawienia` (inni dostają 404).
import Link from 'next/link'
import { Karta, NaglowekStrony, Odznaka, PrzyciskLink } from '@/app/ui'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { daneIntegracji, pozycjeIntegracji, type LogoIntegracji } from '@/lib/panel/integracje'
import { requirePermission } from '@/lib/panel/kontekst'
import allegro from './loga/allegro.svg'
import claude from './loga/claude.svg'
import dokument from './loga/dokument.svg'
import dpd from './loga/dpd.svg'
import klucz from './loga/klucz.svg'
import koperta from './loga/koperta.svg'
import paczka from './loga/paczka.svg'
import prestashop from './loga/prestashop.svg'
import sklep from './loga/sklep.svg'
import woocommerce from './loga/woocommerce.svg'
import './integracje.css'

export const metadata = { title: 'Integracje' }

const registry = defaultRegistry()

const LOGA: Record<LogoIntegracji, { src: string } | string> = { allegro, claude, dokument, dpd, klucz, koperta, paczka, prestashop, sklep, woocommerce }
/** Next daje import obrazu jako obiekt z `src`, Vite (testy) jako sam adres. */
const adresLogo = (l: { src: string } | string) => (typeof l === 'string' ? l : l.src)

export default async function Integracje() {
  const ctx = await requirePermission('ustawienia')
  const grupy = pozycjeIntegracji(await daneIntegracji(ctx.db, registry))
  const wszystkie = grupy.flatMap((g) => g.pozycje)
  // „Bez programu do faktur” to wybór, nie połączenie: nie liczy się do podłączonych
  const podlaczone = wszystkie.filter((p) => p.akcja.etykieta === 'Zarządzaj' && p.klucz !== 'program:brak').length
  return (
    <>
      <NaglowekStrony tytul="Integracje" podtytul={`Co jest podłączone do Kompletora w firmie ${ctx.organization.name}: podłączone ${podlaczone} z ${wszystkie.length}. Szczegóły i klucze zmieniasz przyciskiem przy pozycji.`} />
      <div className="stack">
        {grupy.map((g) => (
          <Karta key={g.klucz} tytul={g.tytul} naglowekPoziom={2} akcje={g.klucz === 'sprzedaz' ? <Link href="/pomoc/integracje">Skąd wziąć klucz</Link> : undefined}>
            {g.pozycje.length === 0 ? (
              <p className="muted small">Brak modułów tego rodzaju w tej instalacji.</p>
            ) : (
              <ul className="plain integracje-lista">
                {g.pozycje.map((p) => (
                  <li key={p.klucz} className="integracja" data-stan={p.akcja.etykieta === 'Podłącz' ? 'brak' : 'jest'}>
                    <span className="integracja-logo" aria-hidden="true">
                      {/* eslint-disable-next-line @next/next/no-img-element -- mały plik SVG z repo, bez optymalizacji obrazu */}
                      <img src={adresLogo(LOGA[p.logo])} alt="" width={28} height={28} />
                    </span>
                    <span className="integracja-opis">
                      <b className="integracja-nazwa">{p.nazwa}</b>
                      <span className="integracja-szczegol">{p.szczegol}</span>
                    </span>
                    <span className="integracja-stany">
                      {p.stany.map((s) => (
                        <Odznaka key={s.tekst} ton={s.ton} rozmiar="sm">
                          {s.tekst}
                        </Odznaka>
                      ))}
                    </span>
                    <PrzyciskLink href={p.akcja.href} rozmiar="sm" aria-label={`${p.akcja.etykieta}: ${p.nazwa}`}>
                      {p.akcja.etykieta}
                    </PrzyciskLink>
                  </li>
                ))}
              </ul>
            )}
          </Karta>
        ))}
      </div>
    </>
  )
}
