// Historia zmian na karcie zamówienia: zdarzenia zamówienia (`OrderEvent`) i dziennik zmian (`AuditLog`
// zamówienia i jego pozycji) na jednej osi czasu, nowsze wyżej. Opisy po ludzku (`eventLabel`), autor imieniem albo
// „system”. Bez danych klienta: z dziennika bierzemy tylko wpisy z listy `AUDYT_KARTY` i pokazujemy własny opis, nigdy
// surowych wartości; wpisów dziennika podglądów danych klienta (KLIENT_PODGLAD) tu nie ma (Ustawienia → Dane klientów).
import type { PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { USUNIECIE_AUDIT } from '@/lib/klienci/retencja'
import { ZAPIS_AUDIT } from '@/lib/klienci/zapis'
import type { Carrier, OrderStatus, ShippingModule } from '@prisma/client'
import { CARRIER_LABEL, eventLabel, STATUS_LABEL } from '@/lib/panel/format'
import { NAZWA_MODULU } from '@/lib/rdzen/przewoznicy'
import { nazwyOsobFirmy } from '@/lib/panel/ustawienia-rezerwacji'
import { AUDIT_PODZIAL, AUDIT_POZYCJA } from '@/lib/rdzen/edycja'
import { AUDIT_PLATNOSC } from './platnosci'
import { OPIS_STANU_DROGI } from '@/lib/wysylka/stany-przesylki'
import { jestRodzajDodatkowej, NAZWA_RODZAJU } from '@/lib/wysylka/dodatkowa'

type Db = PrismaClient

/** Wpisy dziennika zmian, które karta pokazuje (opis własny, bez wartości). */
export const AUDYT_KARTY: Record<string, string> = {
  [AUDIT_POZYCJA]: 'Zmiana pozycji w Kompletorze',
  [AUDIT_PODZIAL]: 'Podział zamówienia',
  [AUDIT_PLATNOSC]: 'Zapis płatności',
  [ZAPIS_AUDIT]: 'Dane klienta zapisane',
  [USUNIECIE_AUDIT]: 'Dane klienta usunięte',
}

export interface WpisHistorii {
  id: string
  kiedy: Date
  opis: string
  /** Imię osoby, „system” albo nazwa toru (biuro, magazyn) dla starszych wpisów. */
  kto: string
  czlowiek: boolean
  zrodlo: 'ZDARZENIE' | 'DZIENNIK'
}

/** Autor wpisu: osoba (`user:<id>`), stare tory panelu i stanowiska, reszta = system (techniczne id nie trafiają na ekran). */
export function autor(actorId: string, nazwy: ReadonlyMap<string, string>): { kto: string; czlowiek: boolean } {
  if (actorId.startsWith('user:')) return { kto: nazwy.get(actorId.slice(5)) ?? 'użytkownik', czlowiek: true }
  if (actorId === 'panel') return { kto: 'biuro', czlowiek: true }
  if (actorId === 'pakowanie') return { kto: 'magazyn', czlowiek: true }
  return { kto: 'system', czlowiek: false }
}

/** Nazwy pól danych klienta w zdarzeniu DANE_KLIENTA_ZMIENIONE (lib/klienci/edycja-danych.ts); spoza listy = pominięte. */
/** Rodzaj danych do faktury po zmianie na karcie; inna wartość nie trafia na ekran. */
const RODZAJ_FAKTURY: Record<string, string> = { BRAK: 'rodzaj: bez danych do faktury', IMIENNA: 'rodzaj: faktura imienna (bez NIP-u)', FIRMA: 'rodzaj: faktura na firmę (NIP)' }

const POLE_DANYCH: Record<string, string> = {
  nabywca_imie_nazwisko: 'imię i nazwisko',
  nabywca_firma: 'firma',
  telefon: 'telefon',
  email: 'e-mail',
  faktura_nazwa: 'nazwa',
  faktura_nip: 'NIP',
  faktura_ulica: 'ulica',
  faktura_kod_pocztowy: 'kod pocztowy',
  faktura_miasto: 'miasto',
}

/** Opis zdarzenia z danymi bez wartości osobowych: ilość przy zmianie, numer paczki przy podziale. */
export function opisZdarzenia(kind: string, data: unknown): string {
  const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  const n = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : null)
  if (kind === 'TOWAR_ZWOLNIONY' && n('godzin') !== null) return `Towar zwolniony: płatność online nieudana${n('godzin') ? `, minęły ${n('godzin')} h` : ''}. Zamówienie czeka na płatność.`
  if (kind === 'TOWAR_ZAREZERWOWANY_PONOWNIE' && n('short') !== null) return `${eventLabel(kind)}: zarezerwowano ${n('reserved') ?? 0} szt.${n('short') ? `, brakuje ${n('short')} szt. (lista braków)` : ''}`
  if (kind === 'ZMIANA_ILOSCI' && n('z') !== null && n('na') !== null) return `${eventLabel(kind)}: ${n('z')} → ${n('na')}`
  // zmiana ceny brutto i VAT pozycji (kwoty i stawki, bez danych klienta)
  const t = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null)
  if (kind === 'ZMIANA_CENY') {
    const czesci: string[] = []
    // kwoty z przecinkiem jak w reszcie karty
    const kw = (k: string) => t(k)?.replace('.', ',') ?? '—'
    if (t('cenaZ') !== t('cenaNa')) czesci.push(`cena ${kw('cenaZ')} → ${kw('cenaNa')} zł`)
    if (t('vatZ') !== t('vatNa')) czesci.push(`VAT ${t('vatZ') ?? 'z katalogu'} → ${t('vatNa') ?? '—'}`)
    return czesci.length ? `${eventLabel(kind)}: ${czesci.join(', ')}` : eventLabel(kind)
  }
  // przeliczenie cen zamówień sprzed rozkładania rabatu (rabat i liczba pozycji, bez danych klienta)
  if (kind === 'RABAT_ROZLOZONY' && Array.isArray(d['pozycje'])) return `${eventLabel(kind)}: rabat ${t('rabat')?.replace('.', ',') ?? '—'} zł, pozycji ${(d['pozycje'] as unknown[]).length}`
  // zmiana sposobu wysyłki z karty: przewoźnik i moduł przed i po (bez adresu i punktu: te są w dzienniku podglądów)
  if (kind === 'SPOSOB_WYSYLKI_ZMIENIONY') {
    const usluga = (c: string | null, m: string | null) => {
      if (!c) return 'bez przewoźnika'
      const nazwa = CARRIER_LABEL[c as Carrier] ?? c
      const modul = m ? (NAZWA_MODULU[m as ShippingModule] ?? m) : null
      return modul && m !== 'BRAK' && c !== 'OSOBISTY' && modul !== nazwa ? `${nazwa} (${modul})` : nazwa
    }
    return `${eventLabel(kind)}: ${usluga(t('z'), t('zModulu'))} → ${usluga(t('na'), t('naModul'))}`
  }
  // dane kupującego albo do faktury poprawione na karcie: część i nazwy pól słowami (wartości tylko w zaszyfrowanym rekordzie)
  if (kind === 'DANE_KLIENTA_ZMIENIONE') {
    const czesc = t('czesc') === 'KUPUJACY' ? 'kupujący' : t('czesc') === 'FAKTURA' ? 'dane do faktury' : null
    const pola = (Array.isArray(d['pola']) ? (d['pola'] as unknown[]) : [])
      .map((p) =>
        p === 'faktura_na_firme'
          ? d['naFirme'] === true
            ? 'faktura na firmę: tak'
            : d['naFirme'] === false
              ? 'faktura na firmę: nie'
              : 'faktura na firmę'
          : p === 'faktura_rodzaj'
            ? (RODZAJ_FAKTURY[t('rodzaj') ?? ''] ?? 'rodzaj danych do faktury')
            : typeof p === 'string'
              ? (POLE_DANYCH[p] ?? null)
              : null,
      )
      .filter((p): p is string => !!p)
    if (!czesc) return eventLabel(kind)
    return pola.length ? `${eventLabel(kind)}, ${czesc}: ${pola.join(', ')}` : `${eventLabel(kind)}, ${czesc}`
  }
  if (kind === 'KWOTA_Z_KANALU' && t('z') && t('na')) {
    const zl = (v: string) => `${v.replace('.', ',')} zł`
    const koszt = t('kosztZ') && t('kosztNa') ? `, wysyłka ${zl(t('kosztZ')!)} → ${zl(t('kosztNa')!)}` : ''
    return `${eventLabel(kind)}: ${zl(t('z')!)} → ${zl(t('na')!)}${koszt}`
  }
  // ceny pozycji ze sklepu (numer pozycji w sklepie i ceny, bez danych klienta)
  if ((kind === 'CENA_Z_KANALU' || kind === 'CENA_W_KANALE_INNA') && Array.isArray(d['pozycje'])) {
    const zl = (v: unknown) => (typeof v === 'string' ? `${v.replace('.', ',')} zł` : '?')
    const p = (d['pozycje'] as Record<string, unknown>[]).slice(0, 10).map((x) => `pozycja ${String(x?.['pozycja'] ?? '?').slice(0, 40)} ${zl(x?.['z'])} → ${zl(x?.['na'])}`)
    if (p.length) return `${eventLabel(kind)}: ${p.join(', ')}`
  }
  // sposób dostawy z kanału (nazwa metody ze sklepu, bez adresu i punktu) i dobrany przewoźnik
  if (kind === 'DOSTAWA_Z_KANALU' && t('sposob')) {
    const c = t('przewoznik')
    const przewoznik = !c || c === 'BRAK' ? 'przewoźnika brak w regułach firmy' : `przewoźnik ${CARRIER_LABEL[c as Carrier] ?? c}`
    const st = t('status')
    return `${eventLabel(kind)}: ${t('sposob')!.slice(0, 120)}, ${przewoznik}${st ? `, status ${STATUS_LABEL[st as OrderStatus] ?? st}` : ''}`
  }
  if (kind === 'KOSZT_WYSYLKI_ZE_SKLEPU' && t('kosztWysylki')) return `${eventLabel(kind)}: ${t('kosztWysylki')!.replace('.', ',')} zł`
  if ((kind === 'POZYCJA_DODANA' || kind === 'POZYCJA_USUNIETA') && n('qty') !== null) return `${eventLabel(kind)} (${n('qty')})`
  if ((kind === 'PODZIAL' || kind === 'PODZIAL_NOWA_PACZKA') && n('packageNo') !== null) return `${eventLabel(kind)}: paczka ${n('packageNo')}`
  // przyjmowanie zamówień Empiku — powód (numery pozycji i stała treść, bez danych klienta)
  if (kind.startsWith('EMPIK_') && typeof d['powod'] === 'string' && kind !== 'EMPIK_ZAAKCEPTOWALBYM') return `${eventLabel(kind)}: ${d['powod'].slice(0, 200)}`
  if (kind === 'EMPIK_PRZYJETE' && d['juzRozstrzygniete'] === true) return 'Empik: zamówienie było już rozstrzygnięte w Empiku (stan pozycji z odczytu)'
  if (kind.startsWith('EMPIK_') && Array.isArray(d['decyzje'])) {
    const odrzucone = (d['decyzje'] as { przyjeta?: unknown }[]).filter((x) => x?.przyjeta === false).length
    if (odrzucone) return `${eventLabel(kind)} (odrzucone pozycje: ${odrzucone})`
  }
  // „Zmień status” z karty: poprzedni i nowy status słowami oraz powód wpisany przez osobę
  if (kind === 'STATUS_RECZNIE') {
    const t = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '')
    const st = (k: string) => STATUS_LABEL[t(k) as OrderStatus] ?? t(k)
    return `${eventLabel(kind)}: ${st('z')} → ${st('na')}${d.odlozone ? ' (anulowanie czeka na fakturę)' : ''}${t('powod') ? `, powód: ${t('powod').slice(0, 300)}` : ''}`
  }
  // automatyczne akcje — „reguła X ustawiła Y”, „reguła X pominięta: powód” (nazwy reguł i statusów firmy)
  if (kind === 'AUTOMAT' || kind === 'AUTOMAT_POMINIETY') {
    const t = (k: string) => (typeof d[k] === 'string' ? (d[k] as string).slice(0, 120) : '')
    const r = t('nazwa') ? `Reguła „${t('nazwa')}”` : 'Automatyczna akcja'
    if (kind === 'AUTOMAT_POMINIETY') return `${r} pominięta: ${t('powod') || 'warunek niespełniony'}`
    if (d.krok === 'ustawStatus') return `${r} ustawiła status „${t('nazwaStatusu') || STATUS_LABEL[t('na') as OrderStatus] || t('na')}”${d.odlozone ? ' (anulowanie czeka na fakturę)' : ''}`
    if (d.krok === 'wyslijEmail') return `${r}: ${t('opis') || 'e-mail zaplanowany'}`
    if (d.krok === 'oznacz') return `${r}: ${d.wartosc === false ? 'gwiazdka zdjęta' : 'gwiazdka ustawiona'}`
    if (d.krok === 'anulujZamowienie') return `${r} anulowała zamówienie`
    return `${r} wykonana`
  }
  if (kind === 'PRZESYLKA_STATUS' && typeof d['status'] === 'string') return `${eventLabel(kind)}: ${typeof d['opis'] === 'string' && d['opis'] ? d['opis'].slice(0, 120) : d['status'].slice(0, 60)}`
  // stan paczki na osi po „Wysłane” (opis po polsku liczony przy wyświetlaniu, kod przewoźnika w nawiasie)
  if (kind === 'PRZESYLKA_STAN' && typeof d['stan'] === 'string') {
    const opis = (OPIS_STANU_DROGI as Record<string, string>)[d['stan']] ?? d['stan'].slice(0, 40)
    const kod = typeof d['kod'] === 'string' && d['kod'] ? ` (kod przewoźnika: ${d['kod'].slice(0, 60)})` : ''
    return `${eventLabel(kind)}: ${opis}${kod}`
  }
  // informacja przewoźnika przy nadaniu (np. zmieniony punkt odbioru), bez danych klienta
  // dodatkowa przesyłka: rodzaj, numer i numer nadania (powód jest w bloku „Przesyłki”)
  if (kind === 'PRZESYLKA_DODATKOWA') {
    const rodzaj = typeof d['rodzaj'] === 'string' && jestRodzajDodatkowej(d['rodzaj']) ? NAZWA_RODZAJU[d['rodzaj']] : 'przesyłka'
    const nr = typeof d['numerNadaniaDodatkowej'] === 'string' ? `, numer nadania ${d['numerNadaniaDodatkowej'].slice(0, 40)}` : ''
    return `${eventLabel(kind)}: ${rodzaj.toLowerCase()} nr ${Number(d['numerDodatkowej']) || '?'}${nr}`
  }
  if (kind === 'PRZESYLKA_UTWORZONA' && typeof d['uwaga'] === 'string' && d['uwaga']) return `${eventLabel(kind)}: ${d['uwaga'].slice(0, 300)}`
  return eventLabel(kind)
}

/** Złożenie osi czasu (czysta funkcja; testy w historia.test.ts). */
export function zlozHistorie(
  zdarzenia: { id: string; kind: string; actorId: string; createdAt: Date; data: unknown }[],
  dziennik: { id: string; entity: string; actorId: string; createdAt: Date }[],
  nazwy: ReadonlyMap<string, string>,
  opts: { tylkoLudzie?: boolean } = {},
): WpisHistorii[] {
  const out: WpisHistorii[] = []
  for (const e of zdarzenia) out.push({ id: `e-${e.id}`, kiedy: e.createdAt, opis: opisZdarzenia(e.kind, e.data), ...autor(e.actorId, nazwy), zrodlo: 'ZDARZENIE' })
  for (const a of dziennik) {
    const opis = AUDYT_KARTY[a.entity]
    if (!opis) continue // tylko wpisy z listy: reszty dziennika karta nie pokazuje
    // zmiana pozycji i podział mają też zdarzenie zamówienia z opisem: wpis dziennika pokazujemy jako ślad osoby
    out.push({ id: `a-${a.id}`, kiedy: a.createdAt, opis, ...autor(a.actorId, nazwy), zrodlo: 'DZIENNIK' })
  }
  out.sort((x, y) => y.kiedy.getTime() - x.kiedy.getTime() || (x.id < y.id ? 1 : -1))
  return opts.tylkoLudzie ? out.filter((w) => w.czlowiek) : out
}

const LIMIT = 200

/** Historia zamówienia: zdarzenia + dziennik zamówienia i jego pozycji. Klient bazy firmy (RLS). */
export async function historiaZamowienia(db: Db, orderId: string, opts: { tylkoLudzie?: boolean; sys?: () => Db } = {}): Promise<WpisHistorii[]> {
  organizationIdOf(db)
  const lines = await db.orderLine.findMany({ where: { orderId }, select: { id: true } })
  const [zdarzenia, dziennik] = await Promise.all([
    db.orderEvent.findMany({ where: { orderId }, orderBy: { createdAt: 'desc' }, take: LIMIT, select: { id: true, kind: true, actorId: true, createdAt: true, data: true } }),
    db.auditLog.findMany({
      where: { entityId: { in: [orderId, ...lines.map((l) => l.id)] }, entity: { in: Object.keys(AUDYT_KARTY) } },
      orderBy: { createdAt: 'desc' },
      take: LIMIT,
      select: { id: true, entity: true, actorId: true, createdAt: true },
    }),
  ])
  // zmiana pozycji z karty ma też zdarzenie (z ilością): w dzienniku zostaje tylko to, czego zdarzenia nie mają
  const zDziennika = dziennik.filter((a) => a.entity !== AUDIT_POZYCJA && a.entity !== AUDIT_PODZIAL)
  const ids = [...new Set([...zdarzenia, ...zDziennika].map((x) => x.actorId).filter((a) => a.startsWith('user:')).map((a) => a.slice(5)))]
  const nazwy = await nazwyOsobFirmy(db, ids, opts.sys ? { sys: opts.sys } : {})
  return zlozHistorie(zdarzenia, zDziennika, nazwy, opts).slice(0, LIMIT)
}
