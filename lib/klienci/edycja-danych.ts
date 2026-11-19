// Edycja danych kupującego i danych do faktury na karcie zamówienia (także zamówień ze sklepu, Allegro i Empiku). Adres
// dostawy i punkt odbioru poprawia `poprawDostawe` (lib/klienci/poprawka.ts, przed nadaniem); tu reszta rekordu klienta:
// - kupujący: imię i nazwisko, firma, telefon, e-mail (kontakt do powiadomień); wolno także po nadaniu i po fakturze;
// - dane do faktury w trzech stanach: bez danych do faktury, faktura imienna (nazwa i adres
//   bez NIP-u), faktura na firmę (NIP z sumą kontrolną); `Order.wantInvoiceNip` = klient chce faktury (imienna albo na
//   firmę). Tylko dopóki do zamówienia (i jego paczek) nie ma faktury ani próby jej wystawienia (wFirma, KSeF, BaseLinker). Faktura ma dane
//   z chwili wystawienia, więc zmiana po niej poprawiłaby tylko Kompletor, nie dokument: karta mówi, że błędne dane
//   nabywcy poprawia faktura korygująca.
// Zasady jak w poprawce adresu: tylko konto w trybie pracy (`bramkaKarty`), odczyt rekordu z celem POPRAWKA (wpis
// w dzienniku podglądów), zapis zaszyfrowany jako RECZNE (kolejny odczyt z kanału go nie nadpisze), drugi wpis
// w dzienniku i zdarzenie w historii zamówienia z NAZWAMI pól (bez wartości). Formularz niesie wersję rekordu, z której
// powstał: zmiana w międzyczasie (druga osoba, poprawka adresu obok) = odmowa zamiast cichego nadpisania.
// Blokady w kolejności klient → zamówienie (jak przesyłka: klient → przesyłka → zamówienie), dokumenty sprzedaży
// sprawdzane pod blokadą zamówienia; szkice KSeF dodatkowo FOR UPDATE, żeby wysyłka do KSeF nie wystartowała w trakcie.
import { Prisma, type PrismaClient } from '@prisma/client'
import { bramkaKarty, ID_RE } from '../karta/bramka'
import { poprawnyNip } from '../ksef/fa3/builder'
import { dokumentSprzedazy, ksefDoPonowienia, STATUSY_KSEF_WYSYLKA } from '../rdzen/dokument-sprzedazy'
import { lockOrder } from '../rdzen/przejscia'
import type { Env } from '../sekrety'
import { daneKlienta, PODGLAD_AUDIT, powodBrakuKlienta } from './odczyt'
import { PUSTY_REKORD, type RekordKlienta } from './rekord'
import { normalizujTelefon } from './skroty'
import { sladZapisu, zapiszRekordKlienta } from './zapis'
import type { RecipientInvoice } from '../adaptery/kontrakt'

export class BladDanychKlienta extends Error {}

export interface DaneKupujacego {
  imieNazwisko: string | null
  firma: string | null
  telefon: string | null
  email: string | null
}

/** BRAK = bez danych do faktury (paragon albo faktura na dane z adresu dostawy); IMIENNA = nazwa i adres bez NIP-u; FIRMA = z NIP-em. */
export type RodzajFaktury = 'BRAK' | 'IMIENNA' | 'FIRMA'

export interface DaneFakturyZamowienia {
  rodzaj: RodzajFaktury
  faktura: RecipientInvoice | null
  /** BRAK przy istniejących danych do faktury: biuro zaznaczyło, że chce je usunąć (bez tego odmowa). */
  usunPotwierdzone?: boolean
}

/** Stan formularza z rekordu: NIP = na firmę, dane bez NIP-u = imienna, sam znacznik „chce faktury” = na firmę, nic = bez danych. */
export function rodzajFaktury(f: RecipientInvoice | null | undefined, chceFaktury: boolean): RodzajFaktury {
  if (f?.nip) return 'FIRMA'
  if (f) return 'IMIENNA'
  return chceFaktury ? 'FIRMA' : 'BRAK'
}

export const NIP_ZAGRANICZNY = 'NIP zagraniczny albo numer VAT UE: Kompletor przyjmuje tu tylko polski NIP. Dane nabywcy zagranicznego popraw w programie do faktur.'
export const NABYWCA_ZAGRANICZNY = 'Nabywca zagraniczny (kraj inny niż Polska): dane do faktury popraw w programie do faktur, nie na karcie.'
export const USUN_FAKTURE_POTWIERDZ = 'Usuwasz dane do faktury: zaznacz „Tak, usuń dane do faktury” pod wyborem albo wybierz fakturę imienną lub na firmę.'

/** Kraj spoza Polski (null i „PL” = Polska). */
const zagraniczny = (kraj: string | null | undefined) => !!kraj && !/^(PL|POLSKA)$/i.test(kraj.trim())

const KOD_PL = /^\d{2}-\d{3}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function pole(form: FormData, nazwa: string, etykieta: string, max = 200): string | null {
  const raw = form.get(nazwa)
  if (raw !== null && typeof raw !== 'string') throw new BladDanychKlienta(`${etykieta}: tekst`)
  const v = (raw ?? '').trim()
  if (!v) return null
  if (v.length > max) throw new BladDanychKlienta(`${etykieta}: najwyżej ${max} znaków`)
  return v
}

/** Kupujący z formularza karty; błąd = BladDanychKlienta z nazwą pola (bez wartości). */
export function kupujacyZFormularza(form: FormData): DaneKupujacego {
  const k: DaneKupujacego = {
    imieNazwisko: pole(form, 'imie', 'Imię i nazwisko'),
    firma: pole(form, 'firma', 'Firma'),
    telefon: pole(form, 'telefon', 'Telefon', 30),
    email: pole(form, 'email', 'E-mail'),
  }
  if (!k.imieNazwisko && !k.firma) throw new BladDanychKlienta('Podaj imię i nazwisko albo firmę kupującego')
  if (k.email && !EMAIL.test(k.email)) throw new BladDanychKlienta('E-mail: zły format')
  if (k.telefon && !normalizujTelefon(k.telefon)) throw new BladDanychKlienta('Telefon: co najmniej 9 cyfr')
  return k
}

/**
 * Dane do faktury z formularza karty (`f_rodzaj`: brak | imienna | firma). Na firmę: nazwa, NIP (10 cyfr z sumą
 * kontrolną; „PL”, spacje i myślniki zdejmowane) oraz ulica, kod i miasto, bo bez adresu faktura nie wyjdzie
 * (`naKontrahenta`). Imienna: nazwa i adres, NIP pusty. Błąd = BladDanychKlienta z nazwą pola (bez wartości).
 */
export function fakturaZFormularza(form: FormData): DaneFakturyZamowienia {
  const r = form.get('f_rodzaj')
  if (r === 'brak') return { rodzaj: 'BRAK', faktura: null, usunPotwierdzone: form.get('f_usun') === 'tak' }
  if (r !== 'imienna' && r !== 'firma') throw new BladDanychKlienta('Wybierz rodzaj danych do faktury')
  const firma = r === 'firma'
  const nazwa = pole(form, 'f_nazwa', firma ? 'Nazwa do faktury' : 'Imię i nazwisko do faktury')
  const nipWe = pole(form, 'f_nip', 'NIP', 20)
  const ulica = pole(form, 'f_ulica', 'Ulica do faktury')
  const kod = pole(form, 'f_kod', 'Kod pocztowy do faktury', 10)
  const miasto = pole(form, 'f_miasto', 'Miasto do faktury')
  let nip: string | null = null
  if (firma) {
    if (!nazwa) throw new BladDanychKlienta('Faktura na firmę: podaj nazwę firmy')
    if (!nipWe) throw new BladDanychKlienta('Faktura na firmę: podaj NIP')
    nip = nipWe.replace(/[\s-]/g, '').replace(/^PL/i, '')
    if (/^[A-Z]{2}/i.test(nip)) throw new BladDanychKlienta(NIP_ZAGRANICZNY)
    if (!(/^\d{10}$/.test(nip) && poprawnyNip(nip))) throw new BladDanychKlienta('NIP: 10 cyfr z poprawną sumą kontrolną')
  } else {
    if (!nazwa) throw new BladDanychKlienta('Faktura imienna: podaj imię i nazwisko')
    if (nipWe) throw new BladDanychKlienta('Faktura imienna jest bez NIP-u: usuń NIP albo wybierz „Faktura na firmę”')
  }
  if (!ulica || !kod || !miasto) throw new BladDanychKlienta('Adres do faktury: ulica z numerem, kod pocztowy i miasto razem')
  if (!KOD_PL.test(kod)) throw new BladDanychKlienta('Kod pocztowy do faktury w formacie NN-NNN')
  return { rodzaj: firma ? 'FIRMA' : 'IMIENNA', faktura: { nazwa, nip, ulica, kodPocztowy: kod, miasto, kraj: 'PL' } }
}

const rozne = (a: string | null | undefined, b: string | null | undefined) => (a ?? null) !== (b ?? null)

/** Nazwy pól kupującego, które zmiana zmienia (do dziennika i historii, bez wartości). */
export function polaKupujacego(stary: RekordKlienta, k: DaneKupujacego): string[] {
  const pary: [string, string | null | undefined, string | null][] = [
    ['nabywca_imie_nazwisko', stary.nabywca?.imieNazwisko, k.imieNazwisko],
    ['nabywca_firma', stary.nabywca?.firma, k.firma],
    ['telefon', stary.telefon, k.telefon],
    ['email', stary.email, k.email],
  ]
  return pary.filter(([, a, b]) => rozne(a, b)).map(([n]) => n)
}

/** Rekord po zmianie kupującego: nabywca i kontakt z formularza, reszta (dostawa, punkt, faktura, login, uwagi) bez zmian. */
export function rekordZKupujacym(stary: RekordKlienta, k: DaneKupujacego): RekordKlienta {
  return {
    ...stary,
    nabywca: { imieNazwisko: k.imieNazwisko, firma: k.firma },
    telefon: k.telefon,
    email: k.email,
    // problemy kanału o kontakcie po poprawce człowieka nie obowiązują
    problemy: stary.problemy.filter((p) => !/^brak_(telefon|email)$/.test(p)),
  }
}

function polaDanychFaktury(a: RecipientInvoice | null | undefined, b: RecipientInvoice | null | undefined): string[] {
  const pary: [string, string | null | undefined, string | null | undefined][] = [
    ['faktura_nazwa', a?.nazwa, b?.nazwa],
    ['faktura_nip', a?.nip, b?.nip],
    ['faktura_ulica', a?.ulica, b?.ulica],
    ['faktura_kod_pocztowy', a?.kodPocztowy, b?.kodPocztowy],
    ['faktura_miasto', a?.miasto, b?.miasto],
  ]
  return pary.filter(([, x, y]) => rozne(x, y)).map(([n]) => n)
}

/** Nazwy pól do faktury, które zmiana zmienia; `faktura_rodzaj`, gdy zmienia się rodzaj (a z nim znacznik „chce faktury”). */
export function polaFaktury(stary: RekordKlienta, staryChceFaktury: boolean, f: DaneFakturyZamowienia): string[] {
  const pola = polaDanychFaktury(stary.faktura, f.faktura)
  // przegląd E2 R2-1: znacznik „chce faktury” zmienia się tylko razem z rodzajem, więc liczy się sam rodzaj
  if (rodzajFaktury(stary.faktura, staryChceFaktury) !== f.rodzaj) pola.push('faktura_rodzaj')
  return pola
}

export function rekordZFaktura(stary: RekordKlienta, faktura: RecipientInvoice | null): RekordKlienta {
  return { ...stary, faktura: faktura ? { ...faktura } : null }
}

// ─── dokumenty sprzedaży ───────────────────────────────────────────────────────

export const FAKTURA_WFIRMA = 'Faktura do tego zamówienia jest już wystawiona w wFirmie albo w trakcie wystawiania: dane do faktury zostają takie, jak na dokumencie. Błędne dane nabywcy poprawia faktura korygująca w wFirmie.'
export const FAKTURA_WFIRMA_NIEWIADOMA = 'Poprzednia próba wystawienia faktury nie dostała odpowiedzi z wFirmy, więc faktura mogła powstać: sprawdź w wFirmie, czy jest, i kliknij „Ponów fakturę” w bloku „Faktura”. Jeśli faktury nie ma, po ponowieniu z błędem dane do faktury znów da się zmienić.'
export const FAKTURA_KSEF = 'Faktura do tego zamówienia poszła już do KSeF, jest w trakcie wysyłki albo mogła do niego dojść (poprzednia próba bez pewnej odpowiedzi): dane do faktury zostają takie, jak na dokumencie. Gdy faktura czeka na „Ponów”, kliknij go najpierw: Kompletor sprawdzi w KSeF, czy ją przyjął. Błędne dane nabywcy przyjętej faktury poprawia faktura korygująca (w Kompletorze korekta powstaje dziś tylko przy zwrocie).'
export const FAKTURA_BL = 'Faktura do tego zamówienia jest w BaseLinkerze: dane do faktury zostają takie, jak na dokumencie. Błędne dane nabywcy poprawiasz fakturą korygującą w BaseLinkerze.'
export const SZKIC_KSEF_PO_ZMIANIE = 'Szkic faktury KSeF złożono przed zmianą: kliknij „Przygotuj szkic ponownie” w bloku „Faktura KSeF”.'
export const KSEF_PO_ZAPISIE_PONOW = 'Faktura KSeF czeka na ponowienie (KSeF jej nie przyjął albo nie wyszła): po zapisie kliknij „Ponów” w bloku „Faktura KSeF”, wyjdzie z poprawionymi danymi i tym samym numerem.'

type Db = PrismaClient | Prisma.TransactionClient

/** Zamówienie i jego paczki (podział, dosłanie): wspólny nabywca, bo faktura paczki dodatkowej bierze go z głównego. */
async function rodzina(db: Db, orderId: string): Promise<string[]> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { parentOrderId: true } })
  if (!o) return [orderId]
  const glowne = o.parentOrderId ?? orderId
  const ids = await db.order.findMany({ where: { OR: [{ id: glowne }, { parentOrderId: glowne }] }, select: { id: true } })
  return [...new Set([orderId, ...ids.map((x) => x.id)])]
}

const POWOD_DOKUMENTU = { WFIRMA: FAKTURA_WFIRMA, WFIRMA_NIEWIADOMA: FAKTURA_WFIRMA_NIEWIADOMA, KSEF: FAKTURA_KSEF, BL: FAKTURA_BL } as const

/**
 * Powód, dla którego danych do faktury nie wolno już zmienić (dokument sprzedaży zamówienia albo jego paczki), null =
 * wolno. `podBlokada` (w transakcji, po `lockOrder`): szkice KSeF FOR UPDATE, wysyłka do KSeF czeka na koniec zapisu.
 * Kryteria (przeglądu E2) w lib/rdzen/dokument-sprzedazy.ts, wspólne z blokadą pozycji zamówienia (E3).
 */
export async function powodBlokadyFaktury(db: Db, orderId: string, o: { podBlokada?: boolean } = {}): Promise<string | null> {
  const rodzaj = await dokumentSprzedazy(db, await rodzina(db, orderId), o)
  return rodzaj ? POWOD_DOKUMENTU[rodzaj] : null
}

/** Co biuro ma zrobić z fakturą KSeF po zapisie: „Ponów” (odrzucona albo nie wyszła) albo szkic do ponownego złożenia. */
async function infoKsefPoZmianie(db: Db, orderId: string): Promise<string | null> {
  const szkice = await db.ksefInvoiceDraft.findMany({ where: { orderId, rodzaj: 'VAT' }, select: { status: true, rodzaj: true, hasheWyslane: true, sesjaRef: true } })
  if (szkice.some(ksefDoPonowienia)) return KSEF_PO_ZAPISIE_PONOW
  if (szkice.some((s) => !(STATUSY_KSEF_WYSYLKA as readonly string[]).includes(s.status))) return SZKIC_KSEF_PO_ZMIANIE
  return null
}

// ─── zapis ─────────────────────────────────────────────────────────────────────

export type WynikEdycjiDanych = { wynik: 'ZAPISANO'; pola: string[]; info: string | null } | { wynik: 'BEZ_ZMIAN' } | { wynik: 'ODMOWA'; powod: string }

export const DANE_ZMIENIONE = 'Dane klienta zmieniły się po otwarciu formularza (inna osoba albo poprawka adresu obok): otwórz formularz ponownie i wpisz zmianę jeszcze raz.'
export const ZDARZENIE_DANYCH = 'DANE_KLIENTA_ZMIENIONE'
export const NAJPIERW_ODSWIEZ = 'Najpierw „Odśwież z kanału”: Kompletor nie ma jeszcze danych klienta tego zamówienia, a zapis z samym kupującym zamroziłby rekord bez adresu (kanał już by go nie uzupełnił).'
/** Przegląd E2 R2-5: zapis danych klientów wyłączony albo trwały błąd odczytu: samo odświeżenie nie pomoże. */
export const NAJPIERW_ODSWIEZ_ALBO_ADRES =
  'Kompletor nie ma jeszcze danych klienta tego zamówienia, a „Odśwież z kanału” teraz nie pomoże (zapis danych klientów jest wyłączony albo odczyt z kanału kończy się błędem). Wpisz adres w „Popraw adres albo punkt odbioru” w sekcji „Przesyłka”: po tym zapisie oba „Edytuj” zadziałają.'
export const PACZKA_DODATKOWA = 'To paczka dodatkowa (podział albo dosłanie): faktura i maile biorą dane klienta z zamówienia głównego, więc zmieniasz je na karcie zamówienia głównego.'
export const RECZNE_FORMULARZ = 'Zamówienie ręczne: dane klienta zmieniasz przyciskiem „Edytuj” w karcie „Dane klienta”.'
const USUNIETE = 'Dane klienta tego zamówienia zostały usunięte.'

interface OpcjeEdycji {
  actorId: string
  /** Wersja rekordu klienta, z której powstał formularz (`rewizja` z odczytu karty; 0 = rekordu nie było). */
  wersja: number
  env?: Env
  now?: Date
}

/** Wersja rekordu klienta w transakcji (po blokadzie `klient:`); 0 = rekordu nie ma, null = dane usunięte. */
async function wersjaPodBlokada(tx: Prisma.TransactionClient, orderId: string): Promise<number | null> {
  const k = await tx.orderCustomer.findUnique({ where: { orderId }, select: { revision: true, purgedAt: true } })
  if (k?.purgedAt) return null
  return k?.revision ?? 0
}

interface Zmiana {
  rekord: RekordKlienta
  pola: string[]
  /** Nowa wartość `Order.wantInvoiceNip` (tylko dane do faktury). */
  chceFaktury?: boolean
  /** Dodatkowe pola zdarzenia w historii (bez danych osobowych). */
  zdarzenie?: Record<string, string>
}

async function wspolnyZapis(
  db: PrismaClient,
  orderId: string,
  o: OpcjeEdycji,
  czesc: 'KUPUJACY' | 'FAKTURA',
  zbuduj: (stary: RekordKlienta, zamowienie: { wantInvoiceNip: boolean }) => Zmiana,
): Promise<WynikEdycjiDanych> {
  const env = o.env ?? process.env
  // zamówienie ręczne ma własny formularz („Wpisz dane klienta”, `zapiszRecznie`); zamówienie innej firmy RLS ukrywa, odmawia bramka
  if (ID_RE.test(orderId) && (await db.order.findUnique({ where: { id: orderId }, select: { channel: true } }))?.channel === 'RECZNE') return { wynik: 'ODMOWA', powod: RECZNE_FORMULARZ }
  const b = await bramkaKarty(db, orderId, (id) => db.order.findUnique({ where: { id }, select: { id: true, channel: true, channelAccountId: true, wantInvoiceNip: true, parentOrderId: true } }), env)
  if (!b.ok) return { wynik: 'ODMOWA', powod: b.blad }
  // (b): faktura i maile paczki dodatkowej biorą dane z zamówienia głównego; zapis tutaj psułby tylko nadanie paczki
  if (b.o.parentOrderId) return { wynik: 'ODMOWA', powod: PACZKA_DODATKOWA }
  if (czesc === 'FAKTURA') {
    const powod = await powodBlokadyFaktury(db, orderId)
    if (powod) return { wynik: 'ODMOWA', powod }
  }
  const d = await daneKlienta(db, orderId, { actorId: o.actorId, zakres: 'PELNY', cel: 'POPRAWKA', env })
  if (d.stan === 'BEZ_UPRAWNIEN' || d.stan === 'SKROT') return { wynik: 'ODMOWA', powod: 'Zmiana danych klienta wymaga uprawnienia do pełnych danych klientów.' }
  if (d.stan === 'USUNIETE') return { wynik: 'ODMOWA', powod: USUNIETE }
  if (d.stan === 'BRAK_KLUCZA' || d.stan === 'BLAD_SZYFRU') return { wynik: 'ODMOWA', powod: 'Dane klienta niedostępne: brak klucza szyfrowania' }
  // (a): rekordu nie ma, a kanał dane podaje: najpierw odczyt z kanału (zapis RECZNE zamroziłby rekord bez adresu)
  if (d.stan === 'BRAK' && (await powodBrakuKlienta(db, orderId, env)) !== 'KANAL_BEZ_ZRODLA') return { wynik: 'ODMOWA', powod: NAJPIERW_ODSWIEZ }
  const stary = d.stan === 'PELNY' ? d.rekord : PUSTY_REKORD
  if ((d.stan === 'PELNY' ? d.rewizja : 0) !== o.wersja) return { wynik: 'ODMOWA', powod: DANE_ZMIENIONE }
  let z: Zmiana
  try {
    z = zbuduj(stary, b.o)
  } catch (e) {
    if (e instanceof BladDanychKlienta) return { wynik: 'ODMOWA', powod: e.message }
    throw e
  }
  if (!z.pola.length) return { wynik: 'BEZ_ZMIAN' }
  const zmiana = z
  const wTransakcji = async (tx: Prisma.TransactionClient) => {
    // pod blokadą klienta: nikt nie zapisał rekordu od odczytu (inaczej nadpisalibyśmy jego zmianę starym rekordem)
    const wersja = await wersjaPodBlokada(tx, orderId)
    if (wersja === null) throw new BladDanychKlienta(USUNIETE)
    if (wersja !== o.wersja) throw new BladDanychKlienta(DANE_ZMIENIONE)
    if (czesc === 'FAKTURA') {
      // klient → zamówienie: dokument sprzedaży sprawdzany pod blokadą zamówienia (wystawienie tworzy próbę pod nią)
      const teraz = await lockOrder(tx, orderId)
      const powod = await powodBlokadyFaktury(tx, orderId, { podBlokada: true })
      if (powod) throw new BladDanychKlienta(powod)
      if (zmiana.chceFaktury !== undefined && teraz.wantInvoiceNip !== zmiana.chceFaktury) await tx.order.update({ where: { id: orderId }, data: { wantInvoiceNip: zmiana.chceFaktury } })
    }
    // historia zamówienia w tej samej transakcji co zapis: kto, kiedy i które pola (wartości tylko w zaszyfrowanym rekordzie)
    await tx.orderEvent.create({
      data: { orderId, kind: ZDARZENIE_DANYCH, actorId: o.actorId.startsWith('user:') ? o.actorId : `user:${o.actorId}`, data: { czesc, pola: zmiana.pola, ...(zmiana.zdarzenie ?? {}) } },
    })
  }
  let w: Awaited<ReturnType<typeof zapiszRekordKlienta>>
  try {
    w = await zapiszRekordKlienta(db, orderId, z.rekord, { source: 'RECZNE', fetchedAt: o.now ?? new Date(), env, nadpiszReczne: true, wTransakcji })
  } catch (e) {
    if (e instanceof BladDanychKlienta) return { wynik: 'ODMOWA', powod: e.message }
    throw e
  }
  if (w === 'BEZ_ZMIAN_USUNIETE') return { wynik: 'ODMOWA', powod: USUNIETE }
  await db.auditLog.create({ data: { entity: PODGLAD_AUDIT, entityId: orderId, actorId: o.actorId, after: { cel: 'POPRAWKA', zakres: 'PELNY', wynik: 'ZAPISANO', pola: z.pola.join(',') } } })
  await sladZapisu(db, orderId, o.actorId, { wynik: w, zrodlo: 'FORMULARZ' })
  const info = czesc === 'FAKTURA' ? await infoKsefPoZmianie(db, orderId) : null
  return { wynik: 'ZAPISANO', pola: z.pola, info }
}

/** Zmiana kupującego i kontaktu (imię i nazwisko, firma, telefon, e-mail) zamówienia `orderId` przez `actorId`. */
export function zmienKupujacego(db: PrismaClient, orderId: string, k: DaneKupujacego, o: OpcjeEdycji): Promise<WynikEdycjiDanych> {
  return wspolnyZapis(db, orderId, o, 'KUPUJACY', (stary) => ({ rekord: rekordZKupujacym(stary, k), pola: polaKupujacego(stary, k) }))
}

/**
 * Zmiana danych do faktury (bez danych / imienna / na firmę), dopóki nie ma dokumentu sprzedaży. Kraj nabywcy zostaje
 * z rekordu; nabywca zagraniczny = odmowa z odesłaniem do programu do faktur. Usunięcie istniejących danych do
 * faktury tylko z potwierdzeniem z formularza.
 */
export function zmienDaneFaktury(db: PrismaClient, orderId: string, f: DaneFakturyZamowienia, o: OpcjeEdycji): Promise<WynikEdycjiDanych> {
  return wspolnyZapis(db, orderId, o, 'FAKTURA', (stary, zam) => {
    if (f.faktura && zagraniczny(stary.faktura?.kraj)) throw new BladDanychKlienta(NABYWCA_ZAGRANICZNY)
    if (f.rodzaj === 'BRAK' && (stary.faktura || zam.wantInvoiceNip) && !f.usunPotwierdzone) throw new BladDanychKlienta(USUN_FAKTURE_POTWIERDZ)
    const nowa = f.faktura ? { ...f.faktura, kraj: stary.faktura ? stary.faktura.kraj : f.faktura.kraj } : null
    const pola = polaFaktury(stary, zam.wantInvoiceNip, { ...f, faktura: nowa })
    // przegląd E2 R2-1: rodzaj bez zmiany = znacznik „chce faktury” zostaje (Empik: firma w adresie rozliczeniowym bez
    // prośby klienta; poprawka literówki nie może wstawić zamówienia do kolejki faktur „tylko na żądanie”)
    const bezZmianyRodzaju = rodzajFaktury(stary.faktura, zam.wantInvoiceNip) === f.rodzaj
    return { rekord: rekordZFaktura(stary, nowa), pola, ...(bezZmianyRodzaju ? {} : { chceFaktury: f.rodzaj !== 'BRAK' }), ...(pola.includes('faktura_rodzaj') ? { zdarzenie: { rodzaj: f.rodzaj } } : {}) }
  })
}

/** Czy dane do faktury różnią się (nazwa, NIP, adres). */
export function fakturaZmieniona(a: RecipientInvoice | null, b: RecipientInvoice | null): boolean {
  return polaDanychFaktury(a, b).length > 0
}

/**
 * Zamówienie ręczne („Wpisz dane klienta”, cały rekord naraz): ta sama blokada danych do faktury po dokumencie sprzedaży.
 * Zmiana kontaktu albo adresu przechodzi; zmiana danych do faktury po fakturze = odmowa z powodem. Gdy dokument powstał
 * między sprawdzeniem a zapisem (wyścig z wystawieniem) albo rekord zmienił się od porównania, zapis odmawia.
 */
export async function zapiszRecznie(db: PrismaClient, orderId: string, rekord: RekordKlienta, o: { actorId: string; env?: Env; now?: Date }): Promise<{ wynik: 'ZAPISANO' | 'BEZ_ZMIAN_USUNIETE' } | { wynik: 'ODMOWA'; powod: string }> {
  const env = o.env ?? process.env
  let rewizja: number | null = null
  const przed = await powodBlokadyFaktury(db, orderId)
  if (przed) {
    const d = await daneKlienta(db, orderId, { actorId: o.actorId, zakres: 'PELNY', cel: 'POPRAWKA', env })
    if (d.stan !== 'PELNY' && d.stan !== 'BRAK') return { wynik: 'ODMOWA', powod: przed }
    const stary = d.stan === 'PELNY' ? d.rekord : PUSTY_REKORD
    if (fakturaZmieniona(stary.faktura, rekord.faktura)) return { wynik: 'ODMOWA', powod: przed }
    rewizja = d.stan === 'PELNY' ? d.rewizja : 0
  }
  try {
    const w = await zapiszRekordKlienta(db, orderId, rekord, {
      source: 'RECZNE',
      fetchedAt: o.now ?? new Date(),
      env,
      nadpiszReczne: true,
      wTransakcji: async (tx) => {
        await lockOrder(tx, orderId)
        const powod = await powodBlokadyFaktury(tx, orderId, { podBlokada: true })
        // dokument jest: dane do faktury porównane z rekordem w wersji sprzed blokady; inna wersja albo brak porównania = odmowa
        if (powod && (rewizja === null || (await wersjaPodBlokada(tx, orderId)) !== rewizja)) throw new BladDanychKlienta(powod)
      },
    })
    return { wynik: w === 'BEZ_ZMIAN_USUNIETE' ? 'BEZ_ZMIAN_USUNIETE' : 'ZAPISANO' }
  } catch (e) {
    if (e instanceof BladDanychKlienta) return { wynik: 'ODMOWA', powod: e.message }
    throw e
  }
}
