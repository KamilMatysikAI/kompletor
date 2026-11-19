// Automaty wysyłki firmy: `Organization.settings.wysylkaAutomaty`. Trzy pierwsze przełączniki domyślnie włączone
// (firma sprzed zmiany dostaje to samo, co przy ręcznym klikaniu, tylko bez klikania), czwarty domyślnie wyłączony:
//   - „Po przyjeździe kuriera oznaczaj jako wysłane” — „Przyjechał <przewoźnik>” przenosi spakowane z numerem nadania
//     tego przewoźnika do „Wysłane” (lib/pakowanie/wyslane-po-przyjezdzie.ts);
//   - „Sprawdzaj u przewoźnika, czy paczka pojechała” — siatka bezpieczeństwa, gdy nikt nie kliknął przyjazdu (zdolność
//     `shipment.track`, tylko przewoźnicy, którzy podają status od ręki);
//   - „Anuluj nieopłacone także w sklepie” — anulowanie nieopłaconego po terminie idzie do kanału przez host zapisu
//     (lib/kanaly/zapis-host.ts); wyłączone = anulujemy tylko u siebie, sklep zostaje bez zmian;
//   - „Śledź paczki aż do doręczenia” — śledzenie (wymaga drugiego przełącznika) pyta przewoźnika także po „Wysłane”,
//     do stanu końcowego, i zapisuje oś statusów oraz historię przesyłki (lib/wysylka/stany-przesylki.ts). Statusu
//     zamówienia po „Wysłane” nie zmienia; zmianę stanu po „Wysłane” zapisuje w historii zamówienia. Domyślnie
//     wyłączone: więcej zapytań do przewoźników;
//   - „Doręczona paczka = Odebrane” i „Powiadamiaj o zwrocie i problemie z paczką” — reguły firmy na osi statusów
//     (lib/wysylka/reguly-drogi.ts), domyślnie wyłączone, działają tylko ze śledzeniem aż do doręczenia i tylko dla
//     przewoźników z listy `wysylkaRegulyDrogi` (domyślnie InPost, Poczta Polska i Wysyłam z Allegro; DPD i każdy nowy moduł poza listą);
//   - „Wysyłaj do sklepu link do śledzenia paczki” — zapis numeru nadania do kanału (lib/kanaly/zapis-host.ts) niesie
//     też adres strony śledzenia (lib/wysylka/link-sledzenia.ts). Domyślnie wyłączone: to zmiana tego, co trafia do
//     sklepu (np. notatka zamówienia), więc firma włącza ją świadomie;
//   - „Pozwalaj dodać kolejną przesyłkę do zamówienia” — przycisk „Dodaj przesyłkę” na karcie zamówienia (dosyłka,
//     paczka zastępcza, druga paczka; lib/wysylka/nadanie.ts `bramkaDodatkowej`). Domyślnie wyłączone: firma włącza
//     ją świadomie, po sprawdzeniu pierwszej dosyłki u swojego przewoźnika.
// Żaden przełącznik nie omija bramek zapisu: kanał dostaje cokolwiek tylko przy koncie w trybie aktywnym z włączonym
// zapisem (`zapisWlaczony`), a zmiana statusu w Kompletorze wymaga trybu pracy konta (lib/praca/wlacznik.ts).
import type { Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'

export interface AutomatyWysylki {
  wyslanePoPrzyjezdzie: boolean
  sledzenie: boolean
  anulowanieWKanale: boolean
  sledzenieDoDoreczenia: boolean
  odebranePoDoreczeniu: boolean
  powiadomieniaODrodze: boolean
  linkSledzeniaDoSklepu: boolean
  dodatkowaPrzesylka: boolean
}

/** Przełączniki dodane po pierwszych trzech: pominięte w zapisie = bez zmiany. */
type Pozniejsze = 'sledzenieDoDoreczenia' | 'odebranePoDoreczeniu' | 'powiadomieniaODrodze' | 'linkSledzeniaDoSklepu' | 'dodatkowaPrzesylka'
const POZNIEJSZE: readonly Pozniejsze[] = ['sledzenieDoDoreczenia', 'odebranePoDoreczeniu', 'powiadomieniaODrodze', 'linkSledzeniaDoSklepu', 'dodatkowaPrzesylka']

export const DOMYSLNE_AUTOMATY: AutomatyWysylki = {
  wyslanePoPrzyjezdzie: true,
  sledzenie: true,
  anulowanieWKanale: true,
  sledzenieDoDoreczenia: false,
  odebranePoDoreczeniu: false,
  powiadomieniaODrodze: false,
  linkSledzeniaDoSklepu: false,
  dodatkowaPrzesylka: false,
}

/** Opisy do ekranu ustawień (bez żargonu). */
export const OPISY_AUTOMATOW: Record<keyof AutomatyWysylki, { nazwa: string; opis: string }> = {
  wyslanePoPrzyjezdzie: {
    nazwa: 'Po przyjeździe kuriera oznaczaj jako wysłane',
    opis: 'Kliknięcie „Przyjechał kurier” na ekranie pakowania przenosi do „Wysłane” wszystkie spakowane paczki tego przewoźnika z numerem nadania. Klient dostaje mail, a sklep status i numer przesyłki, tak jak przy ręcznym kliknięciu „Wysłane”.',
  },
  sledzenie: {
    nazwa: 'Sprawdzaj u przewoźnika, czy paczka pojechała',
    opis: 'Gdy nikt nie kliknie „Przyjechał kurier”, Kompletor co 15 minut pyta przewoźnika o paczki spakowane ponad pół godziny temu. Paczka odebrana przez kuriera przechodzi do „Wysłane”. Działa dla przewoźników, którzy podają status od ręki i są zaznaczeni na liście niżej (domyślnie InPost, Poczta Polska i Base Courier).',
  },
  anulowanieWKanale: {
    nazwa: 'Anuluj nieopłacone także w sklepie',
    opis: 'Zamówienie nieopłacone w terminie Kompletor anuluje u siebie i w sklepie, żeby klient nie zapłacił za zwolniony towar. Sklep z włączonym zapisem, w którym nie da się tego zrobić z Kompletora, daje powiadomienie dla biura: anuluj ręcznie.',
  },
  sledzenieDoDoreczenia: {
    nazwa: 'Śledź paczki aż do doręczenia',
    opis: 'Po „Wysłane” Kompletor dalej pyta przewoźnika o paczkę (co 1 do 6 godzin, zależnie od tego, gdzie jest, najdłużej 30 dni) i zapisuje jej drogę w historii zamówienia: w drodze, w doręczeniu, w punkcie, doręczona, awizo, zwrot. Sam statusu zamówienia nie zmienia. Działa razem z „Sprawdzaj u przewoźnika, czy paczka pojechała”.',
  },
  odebranePoDoreczeniu: {
    nazwa: 'Doręczona paczka = Odebrane',
    opis: 'Gdy przewoźnik poda, że paczka zamówienia jest doręczona, zamówienie z „Wysłane” przechodzi w „Odebrane”, a sklep dostaje ten status, tak jak przy ręcznym kliknięciu. Klient nie dostaje drugiego maila z fakturą. Działa tylko z włączonym „Śledź paczki aż do doręczenia”, dla sklepów w trybie pracy i przewoźników zaznaczonych na liście niżej.',
  },
  powiadomieniaODrodze: {
    nazwa: 'Powiadamiaj o zwrocie i problemie z paczką',
    opis: 'Paczka wraca do nadawcy albo przewoźnik zgłasza problem (zaginięcie, reklamacja): biuro dostaje powiadomienie, a status zamówienia się nie zmienia. Powiadomienie o zwrocie zamyka się, gdy przyjmiesz zwrot w „Zwroty i reklamacje”. Działa tylko z włączonym „Śledź paczki aż do doręczenia”, dla sklepów w trybie pracy i przewoźników zaznaczonych na liście niżej.',
  },
  linkSledzeniaDoSklepu: {
    nazwa: 'Wysyłaj do sklepu link do śledzenia paczki',
    opis: 'Razem z numerem nadania sklep dostaje adres strony śledzenia u przewoźnika (np. w notatce zamówienia WooCommerce, w Empiku jako adres przewoźnika). Link powstaje tylko dla paczek nadanych modułem samego przewoźnika (InPost, DPD, GLS); przy innych sklep dostaje sam numer. Dotyczy numerów zapisanych po włączeniu i tylko sklepów z włączonym zapisem numerów nadania.',
  },
  dodatkowaPrzesylka: {
    nazwa: 'Pozwalaj dodać kolejną przesyłkę do zamówienia',
    opis: 'Na karcie zamówienia spakowanego albo wysłanego, przy bloku „Przesyłki”, pojawia się przycisk „Dodaj przesyłkę”: dosyłka (np. przy reklamacji), paczka zastępcza albo druga paczka, zawsze bez pobrania. Bez drugiej faktury i bez drugiego rozchodu, a sklep i klient dalej widzą numer pierwszej przesyłki. Wyłączone = przycisku nie ma, a już dodane przesyłki zostają na karcie.',
  },
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Odczyt z `Organization.settings`; brak pola albo zła wartość = domyślnie włączone. */
export function parseAutomatyWysylki(settings: Prisma.JsonValue | null | undefined): AutomatyWysylki {
  const a = obj(obj(settings)['wysylkaAutomaty'])
  const flaga = (k: keyof AutomatyWysylki) => (typeof a[k] === 'boolean' ? (a[k] as boolean) : DOMYSLNE_AUTOMATY[k])
  return {
    wyslanePoPrzyjezdzie: flaga('wyslanePoPrzyjezdzie'),
    sledzenie: flaga('sledzenie'),
    anulowanieWKanale: flaga('anulowanieWKanale'),
    sledzenieDoDoreczenia: flaga('sledzenieDoDoreczenia'),
    odebranePoDoreczeniu: flaga('odebranePoDoreczeniu'),
    powiadomieniaODrodze: flaga('powiadomieniaODrodze'),
    linkSledzeniaDoSklepu: flaga('linkSledzeniaDoSklepu'),
    dodatkowaPrzesylka: flaga('dodatkowaPrzesylka'),
  }
}

/** Automaty firmy klienta bazy (RLS: jedna firma). */
export async function automatyWysylki(db: PrismaClient): Promise<AutomatyWysylki> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  return parseAutomatyWysylki(org?.settings ?? null)
}

// ─── Śledzenie per moduł przewoźnika ─────────────────────────────────────────
// `Organization.settings.wysylkaSledzenie`: { <adapterKey>: true|false }. Brak wpisu = ustawienie domyślne modułu:
// moduły śledzone od początku (lista w lib/pakowanie/wyslane-po-przyjezdzie.ts) włączone, nowe wyłączone, więc firma,
// która niczego nie zmieniła, ma dokładnie to samo próbkowanie co przed dodaniem nowych modułów.

export type SledzeniePrzewoznikow = Record<string, boolean>

const KLUCZ_MODULU = /^[a-z0-9][a-z0-9._-]{0,63}$/

type PoleModulow = 'wysylkaSledzenie' | 'wysylkaRegulyDrogi'

function parseMapyModulow(settings: Prisma.JsonValue | null | undefined, pole: PoleModulow): SledzeniePrzewoznikow {
  const s = obj(obj(settings)[pole])
  const wynik: SledzeniePrzewoznikow = {}
  for (const [k, v] of Object.entries(s)) if (KLUCZ_MODULU.test(k) && typeof v === 'boolean') wynik[k] = v
  return wynik
}

/** Odczyt z `Organization.settings`; złe klucze i wartości inne niż boolean pomijamy (= domyślne modułu). */
export function parseSledzeniePrzewoznikow(settings: Prisma.JsonValue | null | undefined): SledzeniePrzewoznikow {
  return parseMapyModulow(settings, 'wysylkaSledzenie')
}

/**
 * Przewoźnicy objęci regułami na osi statusów (`Organization.settings.wysylkaRegulyDrogi`, { <adapterKey>: boolean }).
 * Brak wpisu = domyślne modułu (lib/pakowanie/wyslane-po-przyjezdzie.ts `regulyDrogiModulu`: InPost, Poczta Polska, Wysyłam z Allegro; reszta poza regułami).
 */
export function parseRegulyDrogi(settings: Prisma.JsonValue | null | undefined): SledzeniePrzewoznikow {
  return parseMapyModulow(settings, 'wysylkaRegulyDrogi')
}

export async function regulyDrogiPrzewoznikow(db: PrismaClient): Promise<SledzeniePrzewoznikow> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  return parseRegulyDrogi(org?.settings ?? null)
}

export async function sledzeniePrzewoznikow(db: PrismaClient): Promise<SledzeniePrzewoznikow> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  return parseSledzeniePrzewoznikow(org?.settings ?? null)
}

/**
 * Zapis wyborów modułów (tylko klucze z `dozwolone`, czyli moduły ze śledzeniem w rejestrze). Blokada wiersza firmy,
 * tylko pole `wysylkaSledzenie`, ślad w AuditLog; bez zmian = bez zapisu.
 */
export function zapiszSledzeniePrzewoznikow(db: PrismaClient, nowe: SledzeniePrzewoznikow, dozwolone: readonly string[], actorId: string): Promise<SledzeniePrzewoznikow> {
  return zapiszMapeModulow(db, 'wysylkaSledzenie', nowe, dozwolone, actorId)
}

/** Zapis listy przewoźników objętych regułami na osi (jak `zapiszSledzeniePrzewoznikow`, pole `wysylkaRegulyDrogi`). */
export function zapiszRegulyDrogi(db: PrismaClient, nowe: SledzeniePrzewoznikow, dozwolone: readonly string[], actorId: string): Promise<SledzeniePrzewoznikow> {
  return zapiszMapeModulow(db, 'wysylkaRegulyDrogi', nowe, dozwolone, actorId)
}

async function zapiszMapeModulow(db: PrismaClient, pole: PoleModulow, nowe: SledzeniePrzewoznikow, dozwolone: readonly string[], actorId: string): Promise<SledzeniePrzewoznikow> {
  const organizationId = organizationIdOf(db)
  const czyste: SledzeniePrzewoznikow = {}
  for (const k of dozwolone) if (KLUCZ_MODULU.test(k) && typeof nowe[k] === 'boolean') czyste[k] = nowe[k] === true
  let wynik = czyste
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
    const settings = obj(rows[0]?.settings)
    const przed = parseMapyModulow(rows[0]?.settings ?? null, pole)
    const po = { ...przed, ...czyste }
    wynik = po
    if (Object.keys(czyste).every((k) => przed[k] === czyste[k])) return
    await tx.organization.update({ where: { id: organizationId }, data: { settings: { ...settings, [pole]: po } as Prisma.InputJsonValue } })
    await tx.auditLog.create({ data: { entity: `Organization.${pole}`, entityId: organizationId, actorId, before: { ...przed }, after: { ...po } } })
  })
  return wynik
}

/**
 * Zapis z panelu (Ustawienia → Przewoźnicy): blokada wiersza firmy, tylko pole `wysylkaAutomaty`, ślad w AuditLog.
 * Przełączniki dodane później (`sledzenieDoDoreczenia`, `odebranePoDoreczeniu`, `powiadomieniaODrodze`) pominięte =
 * bez zmiany (wołający sprzed ich dodania ich nie wyłączają).
 */
export async function zapiszAutomatyWysylki(
  db: PrismaClient,
  nowe: Omit<AutomatyWysylki, Pozniejsze> & Partial<Pick<AutomatyWysylki, Pozniejsze>>,
  actorId: string,
): Promise<AutomatyWysylki> {
  const organizationId = organizationIdOf(db)
  let wynik: AutomatyWysylki = DOMYSLNE_AUTOMATY
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
    const settings = obj(rows[0]?.settings)
    const przed = parseAutomatyWysylki(rows[0]?.settings ?? null)
    const czyste: AutomatyWysylki = {
      wyslanePoPrzyjezdzie: nowe.wyslanePoPrzyjezdzie === true,
      sledzenie: nowe.sledzenie === true,
      anulowanieWKanale: nowe.anulowanieWKanale === true,
      sledzenieDoDoreczenia: przed.sledzenieDoDoreczenia,
      odebranePoDoreczeniu: przed.odebranePoDoreczeniu,
      powiadomieniaODrodze: przed.powiadomieniaODrodze,
      linkSledzeniaDoSklepu: przed.linkSledzeniaDoSklepu,
      dodatkowaPrzesylka: przed.dodatkowaPrzesylka,
    }
    for (const k of POZNIEJSZE) if (typeof nowe[k] === 'boolean') czyste[k] = nowe[k] === true
    wynik = czyste
    const klucze = Object.keys(czyste) as (keyof AutomatyWysylki)[]
    if (klucze.every((k) => przed[k] === czyste[k]) && settings['wysylkaAutomaty'] !== undefined) return
    await tx.organization.update({ where: { id: organizationId }, data: { settings: { ...settings, wysylkaAutomaty: { ...czyste } } as Prisma.InputJsonValue } })
    await tx.auditLog.create({ data: { entity: 'Organization.wysylkaAutomaty', entityId: organizationId, actorId, before: { ...przed }, after: { ...czyste } } })
  })
  return wynik
}
