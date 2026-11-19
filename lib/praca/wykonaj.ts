// Wykonanie przycisku z sekcji „Co dalej”. Woła akcja serwera karty zamówienia (akcje-praca.ts) i testy.
// Kolejność: zamówienie firmy (RLS) → obie bramki trybu PRACA (wyłącznik instancji + tryb konta), także przy ręcznym
// wywołaniu → przycisk dostępny wg `dostepnePrzejscia` (status, przewoźnik, uprawnienia) → funkcja rdzenia z
// `actorId: user:<id>`. Rdzeń sprawdza warunki jeszcze raz pod blokadą zamówienia. Powtórka (podwójne kliknięcie,
// ponowione żądanie) nic nie zmienia. Nic nie idzie do kanału, wFirmy ani przewoźnika: zmienia się status w Kompletorze.
import type { Carrier, PrismaClient } from '@prisma/client'
import { cancelPicking, finishPicking, finishWithoutShipping, markReceived, markShipped, readyForDispatch, startPicking } from '@/lib/rdzen/przejscia'
import { PackError, packOrder, shipWithoutInvoice } from '@/lib/rdzen/rozchod'
import { TransitionError } from '@/lib/rdzen/statusy'
import { cancelOrder, isPaid, markPaid, resolveClarification } from '@/lib/rdzen/zamowienia'
import { PakujMimoError, pakujMimoFakturyBl } from '@/lib/rdzen/faktura-bl'
import { flagsOf } from '@/lib/rdzen/rezerwacja'
import { pozostaloDoZwrotu, przyjmijZwrotPoAnulowaniu, ReturnError } from '@/lib/rdzen/zwroty'
import { faktyEkranu, przewoznicyFirmy, wczytajZamowienieEkranu, zamowienieEkranu } from './dane'
import { type AkcjaPracy, celAkcji, dostepnePrzejscia, isAkcjaPracy, numerNadania } from './przejscia-ekran'
import { kontoZamowienia, pracaDostepna } from './wlacznik'

type Db = PrismaClient

export interface ZlecenieAkcji {
  orderId: string
  akcja: string
  userId: string
  uprawnienia: ReadonlySet<string>
  /** „Wysłane”: numer nadania (opcjonalny, tylko do historii). */
  nadanie?: unknown
  /** „Wyjaśnione” z dołożonym towarem: przewoźnik z reguł firmy. */
  przewoznik?: unknown
}

export type WynikAkcji = { blad: string | null; zmiana: boolean }

const WYLACZONE = 'Zmiana statusu z karty działa tylko dla kont w trybie PRACA na instancji z włączonymi ekranami trybu PRACA.'

export async function wykonajPrzejscie(db: Db, z: ZlecenieAkcji, env: Record<string, string | undefined> = process.env): Promise<WynikAkcji> {
  const o = await wczytajZamowienieEkranu(db, String(z.orderId ?? ''))
  if (!o) return { blad: 'Nie ma takiego zamówienia.', zmiana: false }
  let dostepna: boolean
  try {
    dostepna = pracaDostepna(await kontoZamowienia(db, o, env), env)
  } catch {
    return { blad: 'Zła wartość EKRANY_PRACA na tej instancji: zmiana statusu wyłączona.', zmiana: false }
  }
  if (!dostepna) return { blad: WYLACZONE, zmiana: false }
  if (!isAkcjaPracy(z.akcja)) return { blad: 'Nieznana akcja.', zmiana: false }
  const akcja: AkcjaPracy = z.akcja

  const zam = zamowienieEkranu(o)
  if (juzZrobione(akcja, o)) return { blad: null, zmiana: false } // podwójne kliknięcie albo ponowione żądanie
  if (akcja === 'zwrot_na_stan' && o.status === 'ANULOWANE' && !(await pozostaloDoZwrotu(db, o.id)).length) return { blad: null, zmiana: false }
  const p = dostepnePrzejscia(zam, await faktyEkranu(db, o), z.uprawnienia).find((x) => x.akcja === akcja)
  if (!p) return { blad: 'Ta akcja nie pasuje do obecnego stanu zamówienia: odśwież kartę.', zmiana: false }
  if (p.powod) return { blad: p.powod, zmiana: false }

  const ctx = { actorId: `user:${z.userId}` }
  let nadanie: string | null = null
  if (akcja === 'wyslane') {
    const n = numerNadania(z.nadanie)
    if (n === false) return { blad: 'Numer nadania: same litery, cyfry i myślnik, od 4 do 40 znaków (albo zostaw puste).', zmiana: false }
    nadanie = n
  }
  let carrier: Carrier | null = null
  if (akcja === 'wyjasnione' && p.wyborPrzewoznika) {
    const wybrany = (await przewoznicyFirmy(db, o.channel)).find((x) => x.carrier === z.przewoznik)
    if (!wybrany) return { blad: 'W zamówieniu jest towar do wysłania: wybierz przewoźnika z listy.', zmiana: false }
    carrier = wybrany.carrier
  }

  try {
    switch (akcja) {
      case 'oplacone':
        await markPaid(db, o.id, 'PAID', ctx)
        break
      case 'anuluj':
        await cancelOrder(db, o.id, ctx)
        break
      case 'zbieranie':
        await startPicking(db, o.id, ctx)
        break
      case 'spakuj':
        await packOrder(db, o.id, ctx)
        break
      case 'zebrane':
        await finishPicking(db, o.id, ctx)
        break
      case 'przerwij':
        await cancelPicking(db, o.id, ctx)
        break
      case 'wydanie':
        await readyForDispatch(db, o.id, ctx)
        break
      case 'odebrane_bez_wysylki':
        await finishWithoutShipping(db, o.id, ctx)
        break
      case 'bez_faktury':
        await shipWithoutInvoice(db, o.id, ctx)
        break
      case 'wyslane':
        await markShipped(db, o.id, { ...ctx, ...(nadanie ? { trackingNo: nadanie } : {}) })
        break
      case 'odebrane':
        await markReceived(db, o.id, ctx)
        break
      case 'wyjasnione':
        await resolveClarification(db, o.id, { ...ctx, carrier })
        break
      case 'zwrot_na_stan':
        await przyjmijZwrotPoAnulowaniu(db, o.id, ctx)
        break
      case 'pakuj_mimo_faktury_bl':
        await pakujMimoFakturyBl(db, o.id, ctx)
        break
    }
  } catch (e) {
    if (e instanceof ReturnError) {
      // dwa kliknięcia naraz: drugie odbiło się o limit zwrotu, a pierwsze już przyjęło całość
      if (akcja === 'zwrot_na_stan' && !(await pozostaloDoZwrotu(db, o.id)).length) return { blad: null, zmiana: false }
      return { blad: e.message, zmiana: false }
    }
    if (!(e instanceof TransitionError || e instanceof PackError || e instanceof PakujMimoError)) throw e
    // dwa kliknięcia naraz: drugie czekało na blokadę zamówienia, a pierwsze już zrobiło swoje (packOrder nie wraca bez zmian jak moveOrder)
    const teraz = await wczytajZamowienieEkranu(db, o.id)
    if (teraz && juzZrobione(akcja, teraz)) return { blad: null, zmiana: false }
    // ktoś inny zmienił stan w międzyczasie: komunikat bez nazw statusów z kodu
    if (teraz && teraz.status !== o.status) return { blad: 'Ta akcja nie pasuje do obecnego stanu zamówienia: odśwież kartę.', zmiana: false }
    return { blad: e.message, zmiana: false }
  }
  return { blad: null, zmiana: true }
}

/** Stan po akcji już jest: drugi klik nic nie robi i nie pokazuje błędu. */
function juzZrobione(akcja: AkcjaPracy, o: { status: string; carrier: Carrier | null; paymentState: Parameters<typeof isPaid>[0]; pendingAction: string | null; flags?: unknown }): boolean {
  if (akcja === 'oplacone') return isPaid(o.paymentState)
  if (akcja === 'anuluj') return o.status === 'ANULOWANE' || !!o.pendingAction?.startsWith('CANCEL')
  if (akcja === 'wyjasnione') return o.status !== 'DO_WYJASNIENIA'
  if (akcja === 'pakuj_mimo_faktury_bl') return !!flagsOf({ flags: (o.flags ?? null) as Parameters<typeof flagsOf>[0]['flags'] }).pakujMimoFakturyBl
  return o.status === celAkcji(akcja, o)
}
