// Pakowanie → Koszyki (wzorzec BL: koszyki A–J z kodami w asystencie zbierania). Ekran pomocniczy kolejki
// pakowania: przycisk „Koszyki” w nagłówku Pakowania, bez pozycji w menu. 1 zamówienie = 1 koszyk (ustalenie 22.10).
// Widzi osoba z `pakowanie.stanowisko`; dodawanie, usuwanie i ustawienie skanu wymagają `ustawienia`.
import Link from 'next/link'
import { listaKoszykow } from '@/lib/koszyki/koszyki'
import { requirePermission } from '@/lib/panel/kontekst'
import { when } from '@/lib/panel/format'
import { parseUstawienia } from '@/lib/stanowisko/ustawienia'
import { wczytajZamowienia } from '@/lib/stanowisko/zamowienia'
import { Karta, NaglowekStrony, Odznaka, PrzyciskLink, PustyStan, Tabela } from '@/app/ui'
import { DodajKoszyki, Usun, Wymagany, Zwolnij } from './formularze'

export const metadata = { title: 'Koszyki' }

export default async function Koszyki() {
  const ctx = await requirePermission('pakowanie.stanowisko')
  const [koszyki, org] = await Promise.all([listaKoszykow(ctx.db), ctx.db.organization.findUnique({ where: { id: ctx.organization.organizationId }, select: { settings: true } })])
  const zamowienia = await wczytajZamowienia(
    ctx.db,
    koszyki.map((k) => k.orderId).filter((x): x is string => !!x),
  )
  const numer = new Map(zamowienia.map((z) => [z.id, z.numer]))
  const mozeUstawiac = ctx.permissions.has('ustawienia')
  const bezUprawnien = mozeUstawiac ? null : 'Koszyki dodaje i usuwa osoba z uprawnieniem do ustawień firmy'
  const wymagany = parseUstawienia(org?.settings).koszykWymagany
  const zajete = koszyki.filter((k) => k.orderId).length
  const now = new Date()
  return (
    <>
      <NaglowekStrony
        tytul="Koszyki"
        podtytul={koszyki.length ? `${koszyki.length} koszyków, zajęte ${zajete}. Jedno zamówienie = jeden koszyk.` : 'Jedno zamówienie = jeden koszyk. Kod koszyka skanujesz na stanowisku.'}
        akcje={
          koszyki.length > 0 && (
            <PrzyciskLink href="/api/wydruki/koszyki" target="_blank" rel="noopener" prefetch={false}>
              Drukuj kody koszyków
            </PrzyciskLink>
          )
        }
      />

      <Karta tytul="Koszyki firmy">
        <Tabela
          id="koszyki"
          etykieta="Koszyki"
          kolumny={[
            { klucz: 'nazwa', etykieta: 'Koszyk' },
            { klucz: 'kod', etykieta: 'Kod do skanera' },
            { klucz: 'zamowienie', etykieta: 'Zamówienie w koszyku' },
            { klucz: 'akcje', etykieta: 'Akcje', wyrownanie: 'prawo' },
          ]}
          wiersze={koszyki.map((k) => ({
            id: k.id,
            etykieta: `Koszyk ${k.nazwa}`,
            komorki: {
              nazwa: <b className="koszyk-nazwa mono">{k.nazwa}</b>,
              kod: <span className="mono">{k.kod}</span>,
              zamowienie: k.orderId ? (
                <>
                  <Link href={`/zamowienia/${k.orderId}`}>{numer.get(k.orderId) ?? 'zamówienie'}</Link>
                  {k.assignedAt && <span className="muted small"> · od {when(k.assignedAt, now)}</span>}
                </>
              ) : (
                <Odznaka ton="sukces">wolny</Odznaka>
              ),
              akcje: (
                <span className="koszyki-akcje">
                  {k.orderId && <Zwolnij id={k.id} nazwa={k.nazwa} numer={numer.get(k.orderId) ?? 'to zamówienie'} />}
                  <Usun id={k.id} nazwa={k.nazwa} powod={bezUprawnien ?? (k.orderId ? 'Koszyk z zamówieniem najpierw zwolnij' : null)} />
                </span>
              ),
            },
          }))}
          pustyStan={
            <PustyStan tytul="Firma nie ma jeszcze koszyków">
              Dodaj koszyki niżej (np. 10: A–J), wydrukuj kody i naklej na koszyki. Bez koszyków pakujesz jak dotąd, z kartą zamówienia.
            </PustyStan>
          }
        />
      </Karta>

      <Karta tytul="Dodaj koszyki" opis="Nazwa koszyka to jego kod na naklejce: KOSZ-A, KOSZ-B…">
        <DodajKoszyki pierwsze={koszyki.length === 0} powod={bezUprawnien} />
      </Karta>

      <Karta tytul="Na stanowisku">
        <Wymagany wlaczony={wymagany} powod={bezUprawnien} />
        <p className="muted small">
          Jak to działa: zbierając, wkładasz zamówienie do koszyka i skanujesz koszyk przy otwartym zamówieniu (albo na liście zbierania klikasz „Przypisz wolne koszyki”). Przy pakowaniu skan
          koszyka otwiera jego zamówienie. Koszyk zwalnia się sam po spakowaniu (na stanowisku albo z karty), wysłaniu i anulowaniu zamówienia.
        </p>
      </Karta>
    </>
  )
}
