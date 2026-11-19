'use server'
// Akcje sekcji „Klient i dostawa” karty zamówienia. Każda zaczyna od requirePermission (sesja + uprawnienie,
// klient bazy firmy z sesji, RLS), a odczyt danych idzie przez lib/klienci (uprawnienie sprawdzane drugi raz po stronie
// serwera, dziennik podglądów). Komunikaty bez danych klienta.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { naKarte } from '@/lib/karta/komunikaty-serwer'
import { odswiezOpisZKanalu } from '@/lib/karta/opis-z-kanalu'
import { BladDanychKlienta, fakturaZFormularza, KSEF_PO_ZAPISIE_PONOW, kupujacyZFormularza, SZKIC_KSEF_PO_ZMIANIE, zapiszRecznie, zmienDaneFaktury, zmienKupujacego, type WynikEdycjiDanych } from '@/lib/klienci/edycja-danych'
import { daneKlienta } from '@/lib/klienci/odczyt'
import { fakturaWOkresie, USUNIECIE_AUDIT, usunDaneKlientow } from '@/lib/klienci/retencja'
import { BladSzyfruKlienta, KOMUNIKAT_BRAK_KLUCZA } from '@/lib/klienci/szyfr'
import { adresDoKopii, BladFormularzaKlienta, rekordZFormularza } from '@/lib/klienci/walidacja'
import { sladZapisu, zapiszZKanalu } from '@/lib/klienci/zapis'
import { BladOdczytuOdbiorcy, OdmowaOdczytuOdbiorcy } from '@/lib/odbiorca/pobierz'
import { appModeOf } from '@/lib/organizacje'
import { requirePermission } from '@/lib/panel/kontekst'
import { formatData } from '@/lib/wydruki/wspolne'

const ID_RE = /^[a-z0-9]{1,40}$/i
const sciezka = (id: string) => `/zamowienia/${id}`

/** „Odśwież z kanału”: odczyt (`pobierzOdbiorce`, powód ZAPIS) i zapis zaszyfrowany; ślad KLIENT_ZAPIS z wynikiem. */
export async function odswiezKlienta(orderId: string): Promise<{ blad: string | null; info: string | null }> {
  const ctx = await requirePermission('klienci.dane')
  const id = String(orderId ?? '')
  if (!ID_RE.test(id)) return { blad: 'Nie ma takiego zamówienia.', info: null }
  try {
    const r = await zapiszZKanalu(ctx.db, id, {
      registry: defaultRegistry(),
      secrets: { env: process.env, envFallback: appModeOf(process.env) === 'self-host' },
      actorId: ctx.user.id,
    })
    await sladZapisu(ctx.db, id, ctx.user.id, { wynik: r.wynik, zrodlo: 'ODSWIEZ' })
    // ten sam przycisk odświeża też opis i wartość zamówienia (przy otwartych kwotach); to dodatek do danych
    // klienta, więc jego błąd nie zmienia wyniku, a wymaga uprawnienia do edycji pozycji jak „Pobierz nazwy z kanału”
    if (ctx.permissions.has('zamowienia.edycja_pozycji')) {
      try {
        await odswiezOpisZKanalu(ctx.db, id, { registry: defaultRegistry(), secrets: { env: process.env, envFallback: appModeOf(process.env) === 'self-host' }, actorId: `user:${ctx.user.id}` })
      } catch (e) {
        console.error('[karta] odświeżenie opisu z kanału nie powiodło się:', e instanceof Error ? e.name : 'błąd')
      }
    }
    revalidatePath(sciezka(id))
    if (r.wynik === 'BRAK_ZRODLA') return { blad: null, info: 'Kanał nie podaje danych klienta przez API.' }
    if (r.wynik === 'BEZ_ZMIAN_RECZNE') return { blad: null, info: 'Dane wpisane ręcznie: automat ich nie nadpisuje.' }
    if (r.wynik === 'BEZ_ZMIAN_USUNIETE') return { blad: null, info: 'Dane klienta zostały usunięte i nie wracają z kanału.' }
    return { blad: null, info: 'Odświeżono z kanału.' }
  } catch (e) {
    if (e instanceof OdmowaOdczytuOdbiorcy || e instanceof BladOdczytuOdbiorcy) return { blad: e.message, info: null }
    if (e instanceof BladSzyfruKlienta) return { blad: KOMUNIKAT_BRAK_KLUCZA, info: null }
    if (e instanceof Error && e.name === 'BrakKluczaSkrotow') return { blad: 'Dane klienta niedostępne: instalacja nie ma klucza do wyszukiwania klientów (poproś administratora)', info: null }
    throw e
  }
}

/** „Kopiuj adres”: pełny odczyt z celem KOPIA (osobny wpis w dzienniku); tekst wraca tylko do przeglądarki osoby. */
export async function kopiujAdresKlienta(orderId: string): Promise<{ tekst: string | null; blad: string | null }> {
  const ctx = await requirePermission('klienci.dane')
  const id = String(orderId ?? '')
  if (!ID_RE.test(id)) return { tekst: null, blad: 'Nie ma takiego zamówienia.' }
  const d = await daneKlienta(ctx.db, id, { actorId: ctx.user.id, zakres: 'PELNY', cel: 'KOPIA' })
  if (d.stan !== 'PELNY') return { tekst: null, blad: d.stan === 'BRAK_KLUCZA' ? KOMUNIKAT_BRAK_KLUCZA : 'Brak adresu do skopiowania.' }
  const tekst = adresDoKopii(d.rekord)
  return tekst ? { tekst, blad: null } : { tekst: null, blad: 'Brak adresu do skopiowania.' }
}

/** „Wpisz dane klienta” (zamówienie ręczne): walidacja i zapis RECZNE (człowiek może poprawić własny wpis). */
export async function wpiszKlienta(form: FormData): Promise<void> {
  const ctx = await requirePermission('klienci.dane')
  const id = String(form.get('zamowienie') ?? '')
  if (!ID_RE.test(id)) redirect('/zamowienia')
  const o = await ctx.db.order.findUnique({ where: { id }, select: { channel: true } })
  if (!o) redirect('/zamowienia')
  let blad: string | null = null
  if (o.channel !== 'RECZNE') blad = 'Dane wpisuje się ręcznie tylko w zamówieniach ręcznych.'
  else {
    try {
      // dane do faktury po dokumencie sprzedaży zostają takie, jak na dokumencie (lib/klienci/edycja-danych.ts)
      const w = await zapiszRecznie(ctx.db, id, rekordZFormularza(form), { actorId: ctx.user.id, env: process.env })
      if (w.wynik === 'ODMOWA') blad = w.powod
      else {
        await sladZapisu(ctx.db, id, ctx.user.id, { wynik: w.wynik, zrodlo: 'FORMULARZ' })
        if (w.wynik === 'BEZ_ZMIAN_USUNIETE') blad = 'Dane klienta tego zamówienia zostały usunięte.'
      }
    } catch (e) {
      if (e instanceof BladFormularzaKlienta) blad = e.message
      else if (e instanceof BladSzyfruKlienta) blad = KOMUNIKAT_BRAK_KLUCZA
      else if (e instanceof Error && e.name === 'BrakKluczaSkrotow') blad = 'Dane klienta niedostępne: instalacja nie ma klucza do wyszukiwania klientów (poproś administratora)'
      else throw e
    }
  }
  revalidatePath(sciezka(id))
  // wynik zapisu jako toast na karcie (`?ok=<klucz>`, lib/karta/komunikaty.ts)
  redirect(await naKarte(id, blad ? { blad } : { ok: 'klient.zapisano' }))
}

/** Wersja rekordu z ukrytego pola formularza (0 = rekordu nie było); zła wartość = -1 (odmowa „dane zmieniły się”). */
function wersjaZFormularza(form: FormData): number {
  const v = String(form.get('wersja') ?? '')
  return /^\d{1,9}$/.test(v) ? Number(v) : -1
}

/** Wspólne zakończenie formularzy danych: błąd albo komunikat na karcie (kotwica sekcji z „#”), zapis = powrót do odczytu. */
async function poZapisieDanych(id: string, w: WynikEdycjiDanych | { blad: string }, ok: 'klient.kupujacy' | 'klient.faktura', kotwica: string): Promise<never> {
  revalidatePath(sciezka(id))
  if ('blad' in w) redirect(await naKarte(id, { blad: w.blad }, kotwica))
  if (w.wynik === 'ODMOWA') redirect(await naKarte(id, { blad: w.powod }, kotwica))
  if (w.wynik === 'BEZ_ZMIAN') redirect(await naKarte(id, { ok: 'klient.bez-zmian' }, kotwica))
  redirect(await naKarte(id, { ok: w.info === SZKIC_KSEF_PO_ZMIANIE ? 'klient.faktura-szkic' : w.info === KSEF_PO_ZAPISIE_PONOW ? 'klient.faktura-ponow' : ok }, kotwica))
}

function bladDanych(e: unknown): { blad: string } {
  if (e instanceof BladDanychKlienta) return { blad: e.message }
  if (e instanceof BladSzyfruKlienta) return { blad: KOMUNIKAT_BRAK_KLUCZA }
  if (e instanceof Error && e.name === 'BrakKluczaSkrotow') return { blad: 'Dane klienta niedostępne: instalacja nie ma klucza do wyszukiwania klientów (poproś administratora)' }
  throw e
}

/**
 * „Kupujący i kontakt” (zamówienie z kanału): imię i nazwisko, firma, telefon i e-mail kupującego, także po nadaniu.
 * Adres dostawy i punkt zmienia „Popraw adres albo punkt odbioru” w bloku przesyłki. Bramki w lib/klienci/edycja-danych.ts.
 */
export async function zapiszKupujacegoAkcja(form: FormData): Promise<void> {
  const ctx = await requirePermission('klienci.dane')
  const id = String(form.get('zamowienie') ?? '')
  if (!ID_RE.test(id)) redirect('/zamowienia')
  let w: WynikEdycjiDanych | { blad: string }
  try {
    w = await zmienKupujacego(ctx.db, id, kupujacyZFormularza(form), { actorId: ctx.user.id, wersja: wersjaZFormularza(form) })
  } catch (e) {
    w = bladDanych(e)
  }
  return poZapisieDanych(id, w, 'klient.kupujacy', '#wysylka')
}

/** „Dane do faktury” (zamówienie z kanału): bez danych, faktura imienna albo na firmę, nazwa, NIP, adres; tylko przed fakturą. */
export async function zapiszFaktureAkcja(form: FormData): Promise<void> {
  const ctx = await requirePermission('klienci.dane')
  const id = String(form.get('zamowienie') ?? '')
  if (!ID_RE.test(id)) redirect('/zamowienia')
  let w: WynikEdycjiDanych | { blad: string }
  try {
    w = await zmienDaneFaktury(ctx.db, id, fakturaZFormularza(form), { actorId: ctx.user.id, wersja: wersjaZFormularza(form) })
  } catch (e) {
    w = bladDanych(e)
  }
  return poZapisieDanych(id, w, 'klient.faktura', '#dane-faktury')
}

/**
 * „Usuń dane klienta” (żądanie z RODO art. 17): `klienci.dane` + `ustawienia`, potwierdzenie w formularzu. Blokada,
 * gdy zamówienie ma fakturę w okresie przechowywania (dane do faktury trzeba trzymać do końca retencji).
 */
export async function usunKlienta(form: FormData): Promise<void> {
  const ctx = await requirePermission('klienci.dane')
  const id = String(form.get('zamowienie') ?? '')
  if (!ID_RE.test(id)) redirect('/zamowienia')
  let blad: string | null = null
  if (!ctx.permissions.has('ustawienia')) blad = 'Usunięcie danych klienta wymaga też uprawnienia do ustawień firmy.'
  else if (form.get('potwierdzam') !== 'tak') blad = 'Zaznacz potwierdzenie usunięcia.'
  else {
    const f = await fakturaWOkresie(ctx.db, id)
    if (f.blokada) blad = `Nie usuwamy: zamówienie ma fakturę, a dane do faktury przechowujemy do ${formatData(f.do!)} (retencja z fakturą).`
    else {
      try {
        const r = await usunDaneKlientow(ctx.db, process.env, { where: { purgedAt: null, orderId: id }, now: new Date() })
        await ctx.db.auditLog.create({ data: { entity: USUNIECIE_AUDIT, entityId: id, actorId: ctx.user.id, after: { powod: 'RODO_ART_17', liczba: r.usuniete, bledy: r.bledy } } })
        if (r.bledy) blad = 'Nie udało się usunąć danych klienta.'
      } catch (e) {
        if (e instanceof BladSzyfruKlienta) blad = KOMUNIKAT_BRAK_KLUCZA
        else throw e
      }
    }
  }
  revalidatePath(sciezka(id))
  redirect(await naKarte(id, blad ? { blad } : { ok: 'klient.usunieto' }))
}
