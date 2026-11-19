// Lista startu na pulpicie: osiem kroków od świeżej firmy do pierwszego zamówienia, każdy
// z linkiem do ekranu, stanem liczonym z danych firmy i „Pomiń”. Stan kroku wynika z danych (nie z kliknięć), więc lista
// nie kłamie po zmianach poza nią; pominięcia i ukrycie listy to jedyne, co zapisuje (`Organization.settings.start`,
// blokada wiersza firmy, AuditLog). Klient firmy z sesji (RLS); klient systemowy odrzucony.
import type { Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { parseOrgSettings } from '../organizacje'
import { brakiProfilu, parseProfilFirmy } from '../firma/profil'
import { kodKonta } from '../kanaly/konta'
import { prowadziZamowienia, trybKonta } from '../kanaly/tryb'
import { DEFAULT_WAREHOUSE } from '../rdzen/stan'
import { zrodloStanu } from '../rdzen/zrodlo-stanu'
import { przejscieZakonczone } from '../kanaly/firma'
import { PRZEPROWADZKA_ZAPISANA } from '../przeprowadzka/zapis'

export const KROKI_STARTU = ['przeprowadzka', 'dane-firmy', 'magazyn', 'kanal', 'produkty', 'przewoznik', 'przeplyw', 'dokumenty', 'poczta', 'zamowienie', 'przejscie'] as const
export type KrokStartu = (typeof KROKI_STARTU)[number]
export const isKrokStartu = (v: unknown): v is KrokStartu => typeof v === 'string' && (KROKI_STARTU as readonly string[]).includes(v)

export type StanKroku = 'zrobione' | 'do_zrobienia' | 'pominiete'

export interface Krok {
  id: KrokStartu
  tytul: string
  /** Jedno zdanie: co zrobić albo co już jest. */
  opis: string
  href: string
  /** Tekst przycisku przy kroku do zrobienia. */
  akcja: string
  stan: StanKroku
}

export interface ListaStartu {
  kroki: Krok[]
  zrobione: number
  razem: number
  /** Właściciel schował listę („Ukryj listę”). */
  ukryta: boolean
  /** Wszystkie kroki zrobione albo pominięte. */
  gotowe: boolean
}

export interface UstawieniaStartu {
  pominiete: KrokStartu[]
  /** Wybór właściciela („Ukryj listę” / „Pokaż listę”); null = nie wybierał (decyduje `domyslnieUkryta`). */
  ukryta: boolean | null
}

type Json = Record<string, Prisma.JsonValue>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

export function parseUstawieniaStartu(settings: Prisma.JsonValue | null | undefined): UstawieniaStartu {
  const s = isObj(settings) && isObj(settings['start']) ? settings['start'] : {}
  const p = Array.isArray(s['pominiete']) ? s['pominiete'].filter(isKrokStartu) : []
  return { pominiete: [...new Set(p)], ukryta: typeof s['ukryta'] === 'boolean' ? s['ukryta'] : null }
}

/** Fakty o firmie, z których wynikają stany kroków (osobno, żeby reguły dało się sprawdzić bez bazy). */
export interface FaktyStartu {
  /** Firma przechodzi z BaseLinkera (ślad przejścia: katalog BL, przeprowadzka; `firmaPrzechodziZBl`). */
  firmaZBl: boolean
  /** Firma ma klucz API BL zapisany w panelu (pokazuje krok przeprowadzki, bramki nie zmienia). */
  kluczBl: boolean
  /** Instancja nie pozwala tej firmie włączyć trybu pracy z panelu (`blokadaInstancji`). */
  trybPracyZablokowany: boolean
  /**
   * Firma już działa: zamówienia z kanałów starsze niż 7 dni albo katalog BL (cień) bez
   * przeprowadzki. Lista startu jest wtedy domyślnie schowana („Pokaż listę uruchomienia” zostaje).
   */
  firmaDziala: boolean
  przeprowadzkaZapisana: boolean
  /** „Przejście z BaseLinkera zakończone” na ekranie przeprowadzki. */
  przejscieZakonczone: boolean
  brakiDanychFirmy: string[]
  zrodloPotwierdzone: boolean
  kontaSklepow: { nazwa: string; kod: string; aktywne: boolean }[]
  produkty: number
  przewoznikUstawiony: boolean
  dokumentyUstawione: boolean
  pocztaWlaczona: boolean
  zamowienia: number
  /** reguły automatycznych akcji firmy (bez ukrytych); brak = 0 */
  automatyczneAkcje?: number
  /** z nich włączone; krok „Przepływ pracy” zaliczony dopiero przy co najmniej jednej */
  automatyczneAkcjeWlaczone?: number
}

/** Kroki z faktów i ustawień. Krok „Przeprowadzka z BaseLinkera” tylko dla firmy z BL (inne widzą link pod listą). */
export function zbudujListe(f: FaktyStartu, u: UstawieniaStartu): ListaStartu {
  const pom = new Set(u.pominiete)
  const st = (id: KrokStartu, zrobione: boolean): StanKroku => (zrobione ? 'zrobione' : pom.has(id) ? 'pominiete' : 'do_zrobienia')
  const podglad = f.kontaSklepow.filter((k) => !k.aktywne)
  const kroki: Krok[] = []
  if (f.firmaZBl || f.kluczBl)
    kroki.push({
      id: 'przeprowadzka',
      tytul: 'Przenieś dane z BaseLinkera',
      opis: f.przeprowadzkaZapisana ? 'Produkty, oferty i stany są przeniesione.' : 'Najpierw tryb próbny z raportem, potem import produktów, ofert i stanów.',
      href: '/ustawienia/przeprowadzka',
      akcja: 'Przeprowadzka',
      stan: st('przeprowadzka', f.przeprowadzkaZapisana),
    })
  kroki.push(
    {
      id: 'dane-firmy',
      tytul: 'Dane firmy',
      opis: f.brakiDanychFirmy.length ? `Brakuje: ${f.brakiDanychFirmy.join(', ')}. Trafią na dokumenty sprzedaży, etykiety i maile.` : 'Nazwa, NIP i adres są uzupełnione.',
      href: '/ustawienia/firma',
      akcja: 'Uzupełnij',
      stan: st('dane-firmy', f.brakiDanychFirmy.length === 0),
    },
    {
      id: 'magazyn',
      tytul: 'Magazyn i stan towaru',
      opis: f.zrodloPotwierdzone ? 'Wiadomo, kto prowadzi stan magazynu.' : 'Wybierz, czy stan prowadzi Kompletor, czy program księgowy. Jeśli nie masz programu magazynowego, wybierz Kompletor.',
      href: '/ustawienia/dokumenty#h-stan',
      akcja: 'Wybierz',
      stan: st('magazyn', f.zrodloPotwierdzone),
    },
    {
      id: 'kanal',
      tytul: 'Kanał sprzedaży',
      opis: opisKanalu(f, podglad),
      href: f.kontaSklepow.length === 0 ? '/ustawienia/kanaly/nowy' : podglad.length === 1 ? `/ustawienia/kanaly/${encodeURIComponent(podglad[0]!.kod)}#stan` : '/ustawienia/kanaly',
      akcja: f.kontaSklepow.length === 0 ? 'Dodaj sklep' : 'Włącz tryb pracy',
      stan: st('kanal', f.kontaSklepow.length > 0 && (podglad.length === 0 || f.firmaZBl)),
    },
    {
      id: 'produkty',
      tytul: 'Produkty',
      opis: f.produkty > 0 ? `W katalogu: ${f.produkty}.` : 'Dodaj produkty ręcznie albo pobierz je z ofert podłączonego sklepu.',
      href: '/produkty/nowy',
      akcja: 'Dodaj produkt',
      stan: st('produkty', f.produkty > 0),
    },
    {
      id: 'przewoznik',
      tytul: 'Przewoźnik',
      opis: f.przewoznikUstawiony ? 'Godziny odbioru kuriera są ustawione.' : 'Ustaw kuriera i godziny odbioru: od nich zależy kolejka pakowania.',
      href: '/ustawienia/przewoznicy',
      akcja: 'Ustaw',
      stan: st('przewoznik', f.przewoznikUstawiony),
    },
    {
      // gotowy przepływ (statusy + automatyczne akcje) zamiast pustego edytora
      id: 'przeplyw',
      tytul: 'Przepływ pracy',
      opis:
        (f.automatyczneAkcjeWlaczone ?? 0) > 0
          ? `Automatyczne akcje: ${f.automatyczneAkcje ?? 0} (włączone: ${f.automatyczneAkcjeWlaczone}).`
          : (f.automatyczneAkcje ?? 0) > 0
            ? `Automatyczne akcje: ${f.automatyczneAkcje}, wszystkie wyłączone. Sprawdź je na podglądzie i włącz w Ustawieniach → Sprzedaż i kanały → Automatyczne akcje.`
            : 'Wybierz gotowy szablon statusów i automatycznych akcji (kurier i paczkomaty, odbiór osobisty, Allegro, bez wysyłki). Potem dopasujesz go do siebie.',
      href: (f.automatyczneAkcje ?? 0) > 0 ? '/ustawienia/automaty' : '/ustawienia/automaty/szablony',
      akcja: (f.automatyczneAkcje ?? 0) > 0 ? 'Sprawdź i włącz' : 'Wybierz szablon',
      stan: st('przeplyw', (f.automatyczneAkcjeWlaczone ?? 0) > 0),
    },
    {
      id: 'dokumenty',
      tytul: 'Dokumenty sprzedaży',
      opis: f.dokumentyUstawione ? 'Program do faktur jest wybrany.' : 'Wybierz program do faktur albo „bez programu”, jeśli faktury wystawiasz gdzie indziej.',
      href: '/ustawienia/dokumenty#h-program',
      akcja: 'Wybierz',
      stan: st('dokumenty', f.dokumentyUstawione),
    },
    {
      id: 'poczta',
      tytul: 'Poczta',
      opis: f.pocztaWlaczona ? 'Maile do klientów i biura wychodzą z Twojej skrzynki.' : 'Podłącz skrzynkę, z której pójdą maile do klientów i powiadomienia dla biura. Bez niej żaden mail nie wyjdzie.',
      href: '/ustawienia/poczta',
      akcja: 'Podłącz',
      stan: st('poczta', f.pocztaWlaczona),
    },
    {
      id: 'zamowienie',
      tytul: 'Pierwsze zamówienie testowe',
      opis: f.zamowienia > 0 ? `Zamówień w systemie: ${f.zamowienia}.` : 'Dodaj zamówienie ręcznie i przeprowadź je przez pakowanie do wysyłki.',
      href: '/zamowienia/nowe',
      akcja: 'Dodaj zamówienie',
      stan: st('zamowienie', f.zamowienia > 0),
    },
  )
  // (D-x): „Kanał sprzedaży” firmy z BL jest zrobiony przy kontach w podglądzie, więc
  // przełączenie na Kompletora po przeprowadzce dostaje własny, ostatni krok (zrobiony, gdy wszystkie konta pracują)
  if (f.firmaZBl || f.kluczBl || f.przejscieZakonczone) {
    // przed importem (tryb pracy zablokowany) „Włącz tryb pracy” by odmówił, więc krok prowadzi na przeprowadzkę
    const doPrzeprowadzki = f.trybPracyZablokowany && !f.przeprowadzkaZapisana && !f.przejscieZakonczone
    const doKonca = f.trybPracyZablokowany && f.przeprowadzkaZapisana && !f.przejscieZakonczone
    kroki.push({
      id: 'przejscie',
      tytul: 'Przełącz sklepy na Kompletora',
      opis: opisPrzejscia(f, podglad),
      href: doPrzeprowadzki ? '/ustawienia/przeprowadzka' : doKonca ? '/ustawienia/przeprowadzka#koniec' : '/pulpit#stan-kanalow',
      akcja: doPrzeprowadzki ? 'Przeprowadzka' : doKonca ? 'Zakończ przejście' : 'Włącz tryb pracy',
      stan: st('przejscie', f.kontaSklepow.length > 0 && podglad.length === 0),
    })
  }
  const zrobione = kroki.filter((k) => k.stan === 'zrobione').length
  return { kroki, zrobione, razem: kroki.length, ukryta: u.ukryta ?? f.firmaDziala, gotowe: kroki.every((k) => k.stan !== 'do_zrobienia') }
}

/**
 * Opis kroku „Kanał sprzedaży”. Firma z BaseLinkerem ma krok zrobiony przy kontach w podglądzie
 * (tak pracuje do przełączenia), więc opis mówi, co jest, a nie każe czegoś robić.
 */
function opisKanalu(f: FaktyStartu, podglad: FaktyStartu['kontaSklepow']): string {
  if (f.kontaSklepow.length === 0) return 'Podłącz sklep internetowy albo marketplace. Bez sklepu zamówienia dodasz ręcznie.'
  const nazwy = (l: FaktyStartu['kontaSklepow']) => l.map((k) => k.nazwa).join(', ')
  if (!podglad.length) return `Podłączone: ${nazwy(f.kontaSklepow)}.`
  if (f.firmaZBl)
    return f.trybPracyZablokowany
      ? `Podłączone: ${nazwy(f.kontaSklepow)}. Konta zostają w podglądzie, a zamówienia prowadzi BaseLinker do czasu przełączenia po przeprowadzce (tryb pracy włącza administrator serwera albo „Zakończ przejście” na ekranie przeprowadzki).`
      : `Podłączone: ${nazwy(f.kontaSklepow)}. Konta zostają w podglądzie, a zamówienia prowadzi BaseLinker do czasu przełączenia po przeprowadzce („Włącz tryb pracy” w karcie „Stan kanałów”).`
  return `Tylko podgląd: ${nazwy(podglad)}. Włącz tryb pracy na koncie, żeby prowadzić zamówienia w Kompletorze.`
}

/** Opis kroku „Przełącz sklepy na Kompletora”: co jest i co zrobić, w kolejności przejścia. */
function opisPrzejscia(f: FaktyStartu, podglad: FaktyStartu['kontaSklepow']): string {
  if (f.kontaSklepow.length > 0 && podglad.length === 0) return 'Wszystkie konta sklepów pracują w Kompletorze.'
  if (!f.przeprowadzkaZapisana) return 'Po imporcie z BaseLinkera: wyłącz w BaseLinkerze zmiany stanów i statusów, potem włącz tryb pracy kont sklepów.'
  if (f.trybPracyZablokowany && !f.przejscieZakonczone)
    return 'Dane są przeniesione. Gdy odchodzisz od BaseLinkera, oznacz przejście jako zakończone na ekranie przeprowadzki, potem włącz tryb pracy kont sklepów.'
  return 'Wyłącz w BaseLinkerze zmiany stanów i statusów, potem włącz tryb pracy kont sklepów („Włącz tryb pracy” w karcie „Stan kanałów”).'
}

export interface OpcjeStartu {
  firmaZBl: boolean
  kluczBl: boolean
  trybPracyZablokowany: boolean
  now?: Date
}

/** Fakty z bazy firmy. `firmaZBl` liczy wołający (env procesu, lib/kanaly/firma.ts). */
export async function faktyStartu(db: PrismaClient, o: OpcjeStartu): Promise<{ fakty: FaktyStartu; ustawienia: UstawieniaStartu }> {
  organizationIdOf(db)
  const tydzien = new Date((o.now ?? new Date()).getTime() - 7 * 86_400_000)
  const [org, konta, produkty, odbiory, audyt, poczta, zamowienia, zrodlo, przeprowadzka, stareZKanalow] = await Promise.all([
    db.organization.findFirst({ select: { settings: true } }),
    db.channelConfig.findMany({ where: { active: true, channel: { notIn: ['RECZNE', 'AI'] } }, select: { channel: true, channelAccountId: true, name: true, stockMode: true, statusMode: true, trackingMode: true }, orderBy: { name: 'asc' } }),
    db.product.count(),
    db.carrierPickup.count({ where: { example: false, active: true } }),
    db.auditLog.groupBy({ by: ['entity'], where: { entity: { in: ['Warehouse.stockSource', 'Organization.faktury', 'CarrierPickup'] } }, _count: { _all: true } }),
    db.mailSettings.findFirst({ select: { enabled: true } }),
    db.order.count(),
    zrodloStanu(db, DEFAULT_WAREHOUSE),
    db.importRun.count({ where: PRZEPROWADZKA_ZAPISANA }),
    db.order.count({ where: { channel: { notIn: ['RECZNE', 'AI'] }, createdAt: { lt: tydzien } }, take: 1 }),
  ])
  const automatyczneAkcje = await db.automationRule.count({ where: { hidden: false } })
  const automatyczneAkcjeWlaczone = automatyczneAkcje ? await db.automationRule.count({ where: { hidden: false, enabled: true } }) : 0
  const katalogBl = !!parseOrgSettings(org?.settings).baselinker?.inventoryId
  const byl = new Set(audyt.map((a) => a.entity))
  return {
    fakty: {
      firmaZBl: o.firmaZBl,
      kluczBl: o.kluczBl,
      trybPracyZablokowany: o.trybPracyZablokowany,
      firmaDziala: stareZKanalow > 0 || (katalogBl && przeprowadzka === 0),
      przeprowadzkaZapisana: przeprowadzka > 0,
      przejscieZakonczone: !!przejscieZakonczone(org?.settings),
      brakiDanychFirmy: brakiProfilu(parseProfilFirmy(org?.settings)).filter((b) => !['e-mail biura', 'telefon'].includes(b)),
      // wFirma jako źródło da się ustawić tylko świadomie (magazyn wFirmy), więc też liczy się jako wybór
      zrodloPotwierdzone: byl.has('Warehouse.stockSource') || zrodlo === 'WFIRMA',
      kontaSklepow: konta.map((k) => ({ nazwa: k.name, kod: kodKonta(k), aktywne: prowadziZamowienia(trybKonta(k)) })), // praca bez stanów to też tryb pracy
      produkty,
      przewoznikUstawiony: odbiory > 0 || byl.has('CarrierPickup'),
      dokumentyUstawione: byl.has('Organization.faktury'),
      pocztaWlaczona: poczta?.enabled === true,
      zamowienia,
      automatyczneAkcje,
      automatyczneAkcjeWlaczone,
    },
    ustawienia: parseUstawieniaStartu(org?.settings),
  }
}

export async function listaStartu(db: PrismaClient, o: OpcjeStartu): Promise<ListaStartu> {
  const { fakty, ustawienia } = await faktyStartu(db, o)
  return zbudujListe(fakty, ustawienia)
}

export type ZmianaStartu = { krok: KrokStartu; pomin: boolean } | { ukryj: boolean }

/** Pominięcie / przywrócenie kroku albo ukrycie / pokazanie listy. Idempotentne; ślad w AuditLog. */
export async function zmienStart(db: PrismaClient, z: ZmianaStartu, actorId: string): Promise<void> {
  const organizationId = organizationIdOf(db)
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
    if (!rows[0]) throw new Error('Brak firmy klienta')
    const settings: Json = isObj(rows[0].settings) ? rows[0].settings : {}
    const przed = parseUstawieniaStartu(settings)
    const po: UstawieniaStartu = { ...przed, pominiete: [...przed.pominiete] }
    if ('krok' in z) po.pominiete = z.pomin ? [...new Set([...po.pominiete, z.krok])] : po.pominiete.filter((k) => k !== z.krok)
    else po.ukryta = z.ukryj
    if (JSON.stringify(przed) === JSON.stringify(po)) return
    await tx.organization.update({ where: { id: organizationId }, data: { settings: { ...settings, start: po } as unknown as Prisma.InputJsonValue } })
    await tx.auditLog.create({ data: { entity: 'Organization.start', entityId: organizationId, actorId, before: przed as unknown as Prisma.InputJsonValue, after: po as unknown as Prisma.InputJsonValue } })
  })
}
