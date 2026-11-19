'use server'
// Akcje przesyłki: „Utwórz przesyłkę” z gabarytem, „Sprawdź u przewoźnika”, „Pobierz etykietę”, poprawka
// adresu i punktu odbioru przed nadaniem. Używają ich karta zamówienia i stanowisko pakowania. Każda zaczyna od
// requirePermission (sesja + uprawnienie, klient bazy firmy z sesji, RLS). Komunikaty bez danych klienta.
import { revalidatePath } from 'next/cache'
import { zlecZPanelu } from '@/lib/druk/panel'
import { BladDruku } from '@/lib/druk/zlecenia'
import { BladPoprawki, daneDoPoprawki, poprawDostawe, poprawkaZFormularza, type PoprawkaDostawy } from '@/lib/klienci/poprawka'
import { bramkaKarty } from '@/lib/karta/bramka'
import { requirePermission } from '@/lib/panel/kontekst'
import { RODZAJE_DODATKOWEJ } from '@/lib/wysylka/dodatkowa'
import { anulujPrzesylke, bramkaDodatkowej, utworzDodatkowa, bramkaNadania, moznaPoprawicAdres, pobierzEtykiete, przesylkaZamowienia, rozstrzygnijRecznie, sprawdzPrzesylke, utworzPrzesylke, widokPrzesylki, type RozstrzygniecieReczne, type WidokPrzesylki } from '@/lib/wysylka/nadanie'
import { poprzedniaPrzesylka, type PoprzedniaPrzesylka } from '@/lib/wysylka/poprzednia'
import { szukajPunktow, wolnoSzukacPunktow, type PunktZWyszukiwarki } from '@/lib/wysylka/punkt-inpost'
import { InpostPunktyError, pobierzPunkty } from '@/lib/zrodla/inpost-punkty'
import { rodzajDostawy, zmienSposobWysylki } from '@/lib/wysylka/zmiana-sposobu'
import type { Carrier } from '@prisma/client'

const ID_RE = /^[a-z0-9]{1,40}$/i
const KOD_RE = /^[a-z0-9_]{1,40}$/

export interface StanNadania {
  powod: string | null
  nieDotyczy: boolean
  gabaryty: { kod: string; nazwa: string }[]
  modul: string | null
  przesylka: WidokPrzesylki | null
  moznaPoprawic: boolean
  /** Osoba ma `przesylki.rozstrzyganie` (przycisk „Rozstrzygnij ręcznie” przy przesyłce do sprawdzenia). */
  mozeRozstrzygnac: boolean
  /** poprzednia przesyłka tej paczki anulowana albo oznaczona jako niepowstała (kto, kiedy). */
  poprzednia: PoprzedniaPrzesylka | null
}

/** Stan bloku przesyłki (karta i stanowisko); null = brak zamówienia. */
export async function stanNadania(orderId: string): Promise<StanNadania | null> {
  const ctx = await requirePermission('pakowanie.stanowisko')
  const id = String(orderId ?? '')
  if (!ID_RE.test(id)) return null
  const b = await bramkaNadania(ctx.db, id)
  if (!b) return null
  const przesylka = await widokPrzesylki(ctx.db, id)
  // poprzednią przesyłkę komponent pokazuje tylko bez bieżącej, więc tylko wtedy ją liczymy
  return { powod: b.powod, nieDotyczy: b.nieDotyczy, gabaryty: b.gabaryty, modul: b.modul, przesylka, moznaPoprawic: await moznaPoprawicAdres(ctx.db, id), mozeRozstrzygnac: ctx.permissions.has('przesylki.rozstrzyganie'), poprzednia: przesylka ? null : await poprzedniaPrzesylka(ctx.db, id) }
}

export interface WynikPrzyciskuPrzesylki {
  blad: string | null
  info: string | null
  /** Ostrzeżenia do świadomego potwierdzenia (wartości robocze wymiarów i wagi), gdy przesyłka na nie czeka. */
  doPotwierdzenia?: { kod: string; tekst: string }[]
  /** Zlecenie druku etykiety, gdy podano stanowisko. */
  druk?: { id: string; stanowisko: string } | null
}

/**
 * „Utwórz przesyłkę”: host przesyłek (bramki, jedna przesyłka na paczkę), potem — gdy podano stanowisko — druk etykiety
 * na nim (klucz zlecenia od przesyłki: podwójne kliknięcie = jedno zlecenie).
 */
export async function utworzPrzesylkeAkcja(orderId: string, gabaryt: string | null, potwierdzone: string[], stanowisko: string | null): Promise<WynikPrzyciskuPrzesylki> {
  const ctx = await requirePermission('pakowanie.stanowisko')
  const id = String(orderId ?? '')
  if (!ID_RE.test(id)) return { blad: 'Nie ma takiego zamówienia.', info: null }
  const g = gabaryt && KOD_RE.test(String(gabaryt)) ? String(gabaryt) : null
  const pot = Array.isArray(potwierdzone) ? potwierdzone.filter((k) => typeof k === 'string' && KOD_RE.test(k)).slice(0, 20) : []
  const w = await utworzPrzesylke(ctx.db, { orderId: id, gabaryt: g, potwierdzoneOstrzezenia: pot, userId: ctx.user.id })
  revalidatePath(`/zamowienia/${id}`)
  if (w.wynik === 'ODMOWA') return { blad: w.powod, info: null, ...(w.doPotwierdzenia ? { doPotwierdzenia: w.doPotwierdzenia } : {}) }
  if (w.wynik === 'BLAD') return { blad: `Przewoźnik nie utworzył przesyłki: ${w.powod}`, info: null }
  if (w.wynik === 'W_TOKU') return { blad: null, info: 'Przesyłka właśnie powstaje: odśwież za chwilę.' }
  if (w.wynik === 'NIEJEDNOZNACZNA') return { blad: 'Nie wiadomo, czy przesyłka powstała u przewoźnika. Nie twórz jej drugi raz: kliknij „Sprawdź u przewoźnika”.', info: null }
  let druk: WynikPrzyciskuPrzesylki['druk'] = null
  let info = w.istniala ? 'Przesyłka już była utworzona: nic nie wysłano drugi raz.' : `Przesyłka utworzona${w.przesylka.trackingNumber ? `, numer ${w.przesylka.trackingNumber}` : ''}.`
  if (w.info) info += ` ${w.info}`
  if (stanowisko && ID_RE.test(stanowisko) && w.przesylka.labelCiphertext) {
    try {
      const z = await zlecZPanelu(ctx.db, { userId: ctx.user.id, nazwa: ctx.user.name }, { typ: 'etykieta', ids: [id], stationId: stanowisko, klucz: `etykieta-${w.przesylka.id}-auto` })
      druk = { id: z.zlecenie.id, stanowisko: z.zlecenie.cel } // komputer z drukarką i drukarka
    } catch (e) {
      if (e instanceof BladDruku) info += ` Druk: ${e.message}`
      else throw e
    }
  }
  return { blad: null, info, druk }
}

export async function sprawdzPrzesylkeAkcja(orderId: string, shipmentId: string): Promise<WynikPrzyciskuPrzesylki> {
  const ctx = await requirePermission('pakowanie.stanowisko')
  const id = String(orderId ?? '')
  const sid = String(shipmentId ?? '')
  if (!ID_RE.test(id) || !ID_RE.test(sid) || !(await przesylkaZamowienia(ctx.db, sid, id))) return { blad: 'Nie ma takiej przesyłki.', info: null }
  const r = await sprawdzPrzesylke(ctx.db, sid, { userId: ctx.user.id })
  revalidatePath(`/zamowienia/${id}`)
  return r.wynik === 'NADAL_NIEJASNE' ? { blad: r.komunikat, info: null } : { blad: null, info: r.komunikat }
}

/**
 * „Rozstrzygnij ręcznie”: po sprawdzeniu w panelu przewoźnika człowiek z `przesylki.rozstrzyganie`
 * zapisuje „istnieje, numer …” albo „nie powstała”. Wpis AuditLog i zamknięcie alertu robi host.
 */
export async function rozstrzygnijPrzesylkeAkcja(orderId: string, shipmentId: string, wariant: string, numer: string | null): Promise<WynikPrzyciskuPrzesylki> {
  const ctx = await requirePermission('przesylki.rozstrzyganie')
  const id = String(orderId ?? '')
  const sid = String(shipmentId ?? '')
  if (!ID_RE.test(id) || !ID_RE.test(sid) || !(await przesylkaZamowienia(ctx.db, sid, id))) return { blad: 'Nie ma takiej przesyłki.', info: null }
  const r: RozstrzygniecieReczne | null = wariant === 'NIE_POWSTALA' ? { wariant: 'NIE_POWSTALA' } : wariant === 'ISTNIEJE' ? { wariant: 'ISTNIEJE', numer: String(numer ?? '').slice(0, 80) } : null
  if (!r) return { blad: 'Wybierz, czy przesyłka istnieje u przewoźnika.', info: null }
  const w = await rozstrzygnijRecznie(ctx.db, sid, r, { userId: ctx.user.id })
  revalidatePath(`/zamowienia/${id}`)
  return w.wynik === 'ODMOWA' ? { blad: w.komunikat, info: null } : { blad: null, info: w.komunikat }
}

export async function pobierzEtykieteAkcja(orderId: string, shipmentId: string): Promise<WynikPrzyciskuPrzesylki> {
  const ctx = await requirePermission('pakowanie.stanowisko')
  const id = String(orderId ?? '')
  const sid = String(shipmentId ?? '')
  if (!ID_RE.test(id) || !ID_RE.test(sid) || !(await przesylkaZamowienia(ctx.db, sid, id))) return { blad: 'Nie ma takiej przesyłki.', info: null }
  const r = await pobierzEtykiete(ctx.db, sid, { actorId: `user:${ctx.user.id}` })
  revalidatePath(`/zamowienia/${id}`)
  return r.blad ? { blad: r.blad, info: null } : { blad: null, info: 'Etykieta pobrana od przewoźnika.' }
}

/** Wartości do formularza „Popraw adres i punkt” (otwarcie formularza = wpis w dzienniku podglądów, cel POPRAWKA). */
export async function daneDoPoprawkiAkcja(orderId: string): Promise<PoprawkaDostawy | null> {
  const ctx = await requirePermission('klienci.dane')
  const id = String(orderId ?? '')
  if (!ID_RE.test(id)) return null
  return daneDoPoprawki(ctx.db, id, { actorId: ctx.user.id })
}

/** Odmowa bramki karty (zamówienie firmy, tryb pracy konta) albo null. */
async function trybKarty(db: Parameters<typeof bramkaKarty>[0], id: string): Promise<string | null> {
  const b = await bramkaKarty(db, id, (x) => db.order.findUnique({ where: { id: x }, select: { channel: true, channelAccountId: true } }))
  return b.ok ? null : b.blad
}

/** „Popraw adres i punkt”: tylko przed nadaniem i w trybie pracy; zapis RECZNE z wpisem w dzienniku podglądów (nazwy pól, bez wartości). */
export async function poprawAdresAkcja(orderId: string, form: FormData): Promise<WynikPrzyciskuPrzesylki> {
  const ctx = await requirePermission('klienci.dane')
  const id = String(orderId ?? '')
  if (!ID_RE.test(id)) return { blad: 'Nie ma takiego zamówienia.', info: null }
  // tryb pracy jak przy nadaniu i zmianie sposobu wysyłki: w „Tylko podgląd” adres poprawia się tam, gdzie prowadzisz zamówienia dziś
  const b = await trybKarty(ctx.db, id)
  if (b) return { blad: b, info: null }
  if (!(await moznaPoprawicAdres(ctx.db, id))) return { blad: 'Przesyłka już jest utworzona: adres zmienia się w panelu przewoźnika, nie tutaj.', info: null }
  try {
    const w = await poprawDostawe(ctx.db, id, poprawkaZFormularza(form), { actorId: ctx.user.id, zrodloPunktu: form.get('punkt_z_wyszukiwarki') === 'tak' ? 'WYSZUKIWARKA' : 'FORMULARZ' })
    revalidatePath(`/zamowienia/${id}`)
    if (w.wynik === 'ODMOWA') return { blad: w.powod, info: null }
    if (w.wynik === 'BEZ_ZMIAN') return { blad: null, info: 'Bez zmian.' }
    return { blad: null, info: 'Adres poprawiony. Zmiana jest w dzienniku podglądów danych klientów.' }
  } catch (e) {
    if (e instanceof BladPoprawki) return { blad: e.message, info: null }
    if (e instanceof Error && e.name === 'BrakKluczaSkrotow') return { blad: 'Dane klienta niedostępne: brak klucza skrótów (CUSTOMER_LOOKUP_KEY)', info: null }
    if (e instanceof Error && /BladSzyfruKlienta|BrakKluczaKlientow/.test(e.name)) return { blad: 'Dane klienta niedostępne: brak klucza szyfrowania', info: null }
    throw e
  }
}

/**
 * „Anuluj przesyłkę” u przewoźnika, który to umie (Wysyłam z Allegro). Pytanie przed kliknięciem robi ekran
 * (PrzyciskPotwierdz); host wysyła jedną komendę anulowania także przy podwójnym kliknięciu.
 */
export async function anulujPrzesylkeAkcja(orderId: string, shipmentId: string): Promise<WynikPrzyciskuPrzesylki> {
  const ctx = await requirePermission('pakowanie.stanowisko')
  const id = String(orderId ?? '')
  const sid = String(shipmentId ?? '')
  if (!ID_RE.test(id) || !ID_RE.test(sid) || !(await przesylkaZamowienia(ctx.db, sid, id))) return { blad: 'Nie ma takiej przesyłki.', info: null }
  const r = await anulujPrzesylke(ctx.db, sid, { userId: ctx.user.id })
  revalidatePath(`/zamowienia/${id}`)
  return r.wynik === 'ANULOWANA' ? { blad: null, info: r.komunikat } : { blad: r.komunikat, info: null }
}

/**
 * wyszukiwarka punktów odbioru InPost (paczkomaty, PaczkoPunkty) przy poprawce punktu przed nadaniem: kod
 * paczkomatu, kod pocztowy albo miasto. Tylko odczyt publicznego API punktów (bez tokenu firmy, nic nie kosztuje).
 * Wybrany punkt zapisuje się zwykłą poprawką („Zapisz poprawkę”), z wpisem w historii zamówienia.
 */
export async function szukajPunktowAkcja(orderId: string, fraza: string): Promise<{ punkty: PunktZWyszukiwarki[]; blad: string | null }> {
  const ctx = await requirePermission('klienci.dane')
  const id = String(orderId ?? '')
  if (!ID_RE.test(id)) return { punkty: [], blad: 'Nie ma takiego zamówienia.' }
  const b = await trybKarty(ctx.db, id)
  if (b) return { punkty: [], blad: b }
  if (!(await moznaPoprawicAdres(ctx.db, id))) return { punkty: [], blad: 'Przesyłka już jest utworzona: punkt zmienia się w panelu przewoźnika, nie tutaj.' }
  if (!wolnoSzukacPunktow(ctx.organization.organizationId)) return { punkty: [], blad: 'Za dużo wyszukiwań punktów w ostatniej minucie: odczekaj chwilę albo wpisz kod punktu ręcznie.' }
  try {
    const punkty = await szukajPunktow((q) => pobierzPunkty(q), String(fraza ?? '').slice(0, 60))
    return { punkty, blad: punkty.length ? null : 'Nie znaleziono punktów: sprawdź kod paczkomatu albo wpisz miasto.' }
  } catch (e) {
    if (e instanceof InpostPunktyError) return { punkty: [], blad: e.retryable ? 'Wyszukiwarka punktów InPost chwilowo nie odpowiada: spróbuj za chwilę albo wpisz kod punktu ręcznie.' : 'Wyszukiwarka punktów InPost odrzuciła zapytanie: wpisz kod punktu ręcznie.' }
    if (e instanceof Error && /^Wpisz kod/.test(e.message)) return { punkty: [], blad: e.message }
    console.error('[punkty-inpost]', e instanceof Error ? e.message : e)
    return { punkty: [], blad: 'Nie udało się odczytać listy punktów: wpisz kod punktu ręcznie.' }
  }
}

const KLUCZ_SPOSOBU_RE = /^[A-Z_]{2,30}:[A-Z_]{2,30}$/

/**
 * „Zmień sposób wysyłki” (np. Paczkomat → kurier DPD) przed nadaniem: dane odbiorcy z formularza (adres, punkt) jak przy
 * poprawce adresu, bramki trybu pracy, przesyłki, statusu, pobrania i Allegro w lib/wysylka/zmiana-sposobu.ts. Wymaga
 * pełnych danych klientów (formularz pokazuje adres) i pakowania (ta sama osoba nadaje przesyłkę).
 */
export async function zmienSposobAkcja(orderId: string, form: FormData): Promise<WynikPrzyciskuPrzesylki> {
  const ctx = await requirePermission('klienci.dane')
  const id = String(orderId ?? '')
  if (!ID_RE.test(id)) return { blad: 'Nie ma takiego zamówienia.', info: null }
  if (!ctx.permissions.has('pakowanie.stanowisko')) return { blad: 'Sposób wysyłki zmienia osoba z uprawnieniem do pakowania i nadawania przesyłek.', info: null }
  const klucz = String(form.get('sposob') ?? '')
  if (!KLUCZ_SPOSOBU_RE.test(klucz)) return { blad: 'Wybierz nowy sposób wysyłki.', info: null }
  const rodzaj = rodzajDostawy(klucz.split(':')[0] as Carrier)
  try {
    const dostawa = rodzaj === 'ODBIOR' || rodzaj === 'Z_KANALU' || rodzaj === null ? null : poprawkaZFormularza(form)
    const w = await zmienSposobWysylki(ctx.db, id, { klucz, dostawa, zrodloPunktu: form.get('punkt_z_wyszukiwarki') === 'tak' ? 'WYSZUKIWARKA' : 'FORMULARZ' }, { actorId: ctx.user.id })
    revalidatePath(`/zamowienia/${id}`)
    if (w.wynik === 'ODMOWA') return { blad: w.powod, info: null }
    if (w.wynik === 'BEZ_ZMIAN') return { blad: null, info: 'To już jest sposób wysyłki tego zamówienia: adres i punkt poprawisz w „Popraw adres albo punkt odbioru”.' }
    return { blad: null, info: ['Sposób wysyłki zmieniony. Utwórz przesyłkę nową usługą.', w.info].filter(Boolean).join(' ') }
  } catch (e) {
    if (e instanceof BladPoprawki) return { blad: e.message, info: null }
    if (e instanceof Error && e.name === 'BrakKluczaSkrotow') return { blad: 'Dane klienta niedostępne: brak klucza skrótów (CUSTOMER_LOOKUP_KEY)', info: null }
    if (e instanceof Error && /BladSzyfruKlienta|BrakKluczaKlientow/.test(e.name)) return { blad: 'Dane klienta niedostępne: brak klucza szyfrowania', info: null }
    throw e
  }
}

export interface StanDodatkowej {
  powod: string | null
  nastepnyNumer: number
  moduly: { regulaId: string; nazwa: string; zamowienia: boolean }[]
  gabaryty: { kod: string; nazwa: string }[]
  rodzaje: { kod: string; nazwa: string }[]
  doSprawdzenia: { shipmentId: string; numer: number; referencja: string; rozstrzygalna: boolean; rozstrzygniecie: { etykietaNumeru: string; wskazowka: string } } | null
  /** Osoba ma `przesylki.rozstrzyganie` („Rozstrzygnij ręcznie” przy niejasnej dodatkowej przesyłce). */
  mozeRozstrzygnac: boolean
}

/** Stan okna „Dodaj przesyłkę” (dodatkowa przesyłka do zamówienia); null = brak zamówienia albo uprawnienia. */
export async function stanDodatkowejAkcja(orderId: string): Promise<StanDodatkowej | null> {
  const ctx = await requirePermission('pakowanie.stanowisko')
  const id = String(orderId ?? '')
  if (!ID_RE.test(id)) return null
  const b = await bramkaDodatkowej(ctx.db, id)
  if (!b) return null
  return { ...b, rodzaje: Object.entries(RODZAJE_DODATKOWEJ).map(([kod, nazwa]) => ({ kod, nazwa })), mozeRozstrzygnac: ctx.permissions.has('przesylki.rozstrzyganie') }
}

/**
 * „Dodaj przesyłkę”: dodatkowa przesyłka u przewoźnika (dosyłka, paczka zastępcza, druga paczka) z rodzajem, powodem
 * i potwierdzeniem; host pilnuje numeru z okna (ponowne kliknięcie nie tworzy drugiej etykiety). Status zamówienia,
 * dokumenty i numer w sklepie bez zmian. To samo uprawnienie co „Utwórz przesyłkę”.
 */
export async function dodajPrzesylkeAkcja(
  orderId: string,
  p: { numer: number; regulaId: string; rodzaj: string; powod: string; gabaryt: string; koszt: string; potwierdzam: boolean; potwierdzone: string[] },
): Promise<WynikPrzyciskuPrzesylki> {
  const ctx = await requirePermission('pakowanie.stanowisko')
  const id = String(orderId ?? '')
  if (!ID_RE.test(id) || !p || typeof p !== 'object') return { blad: 'Nie ma takiego zamówienia.', info: null }
  const regulaId = String(p.regulaId ?? '')
  if (!ID_RE.test(regulaId)) return { blad: 'Wybierz moduł przewoźnika z listy.', info: null }
  const pot = Array.isArray(p.potwierdzone) ? p.potwierdzone.filter((k) => typeof k === 'string' && KOD_RE.test(k)).slice(0, 20) : []
  const w = await utworzDodatkowa(ctx.db, {
    orderId: id,
    numer: Number(p.numer),
    regulaId,
    rodzaj: String(p.rodzaj ?? '').slice(0, 20),
    powod: String(p.powod ?? '').slice(0, 400),
    gabaryt: String(p.gabaryt ?? '').slice(0, 40),
    koszt: String(p.koszt ?? '').slice(0, 20),
    potwierdzam: p.potwierdzam === true,
    potwierdzoneOstrzezenia: pot,
    userId: ctx.user.id,
  })
  revalidatePath(`/zamowienia/${id}`)
  if (w.wynik === 'ODMOWA') return { blad: w.powod, info: null, ...(w.doPotwierdzenia ? { doPotwierdzenia: w.doPotwierdzenia } : {}) }
  if (w.wynik === 'BLAD') return { blad: `Przewoźnik nie utworzył przesyłki: ${w.powod} Kliknij „Utwórz” ponownie w tym samym oknie (nie powstanie druga paczka).`, info: null }
  if (w.wynik === 'W_TOKU') return { blad: null, info: 'Przesyłka właśnie powstaje: odśwież za chwilę.' }
  if (w.wynik === 'NIEJEDNOZNACZNA') return { blad: 'Nie wiadomo, czy przesyłka powstała u przewoźnika. Nie dodawaj jej drugi raz: kliknij „Sprawdź u przewoźnika” w tym oknie.', info: null }
  let info = w.istniala ? 'Ta przesyłka już była utworzona: nic nie wysłano drugi raz.' : `Dodatkowa przesyłka utworzona${w.przesylka.trackingNumber ? `, numer ${w.przesylka.trackingNumber}` : ''}. Status zamówienia i numer w sklepie bez zmian.`
  if (w.info) info += ` ${w.info}`
  return { blad: null, info }
}
