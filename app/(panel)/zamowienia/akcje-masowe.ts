'use server'
// Akcje masowe listy zamówień. Każda akcja zaczyna od sesji i uprawnienia (requirePermission: klient bazy
// firmy z sesji, RLS); parametry i pozycje sprawdza lib/zamowienia/masowo.ts, które woła te same funkcje co karta
// zamówienia (zmiana statusu z powodem, host przesyłek, druk). Poniżej progu (zmiana statusu 50, przesyłki i etykiety
// 10: masowo-progi.ts) od razu z raportem w toaście, od progu w tle (wiersz z postępem + zadanie kolejki): lista
// odświeża się i pokazuje jeden pasek postępu ze strony (ostatnieAkcje), a po końcu raport.
import { revalidatePath } from 'next/cache'
import { requireSession } from '@/lib/panel/kontekst'
import { filtryZSzukaniem } from '@/lib/panel/szukaj-lista'
import { idPasujacych } from '@/lib/panel/zamowienia-lista'
import { bladParametrow, idZFormularza, MAKS_AKCJI, NAZWA_AKCJI, PROG_TLA, RODZAJE, stanAkcji, UPRAWNIENIE, wykonajOdRazu, zlecWTle, type ParametryAkcji, type RodzajAkcji, type StanAkcji, type WynikPozycji } from '@/lib/zamowienia/masowo'

export interface StanAkcjiMasowej {
  ok?: boolean
  komunikat: string | null
  /** akcja w tle: id do odpytywania postępu */
  wTle?: string
  bledy?: WynikPozycji[]
  /** licznik wysłań: ten sam komunikat dwa razy pod rząd też pokazuje toast */
  n?: number
}

function zdanie(rodzaj: RodzajAkcji, ok: number, bledy: number): string {
  const nazwa = NAZWA_AKCJI[rodzaj]
  if (!bledy) return `${nazwa}: gotowe dla ${ok} zamówień.`
  if (!ok) return `${nazwa}: nie udało się dla żadnego z ${bledy} zamówień.`
  return `${nazwa}: ${ok} gotowe, ${bledy} z błędem (lista pod paskiem).`
}

export async function akcjaMasowa(poprzedni: StanAkcjiMasowej, form: FormData): Promise<StanAkcjiMasowej> {
  const ctx = await requireSession()
  const n = (poprzedni.n ?? 0) + 1
  const rodzaj = String(form.get('rodzaj') ?? '') as RodzajAkcji
  if (!RODZAJE.includes(rodzaj)) return { ok: false, komunikat: 'Nieznana akcja.', n }
  if (!ctx.permissions.has(UPRAWNIENIE[rodzaj])) return { ok: false, komunikat: 'Nie masz uprawnienia do tej akcji (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).', n }
  let ids: string[]
  if (form.get('wszystkie') === 'tak') {
    // „na wszystkich stronach”: identyfikatory z tych samych filtrów co lista, liczone na serwerze
    const sp = Object.fromEntries([...new URLSearchParams(String(form.get('filtry') ?? '')).entries()])
    // z wyszukiwaniem z listy (`qz`, stare `kh`/`kf`), ten sam zbiór co ekran
    const { f } = await filtryZSzukaniem(sp, { db: ctx.db, actorId: ctx.user.id, organizationId: ctx.organization.organizationId, canKlient: ctx.permissions.has('klienci.dane') })
    const r = await idPasujacych(ctx.db, f, MAKS_AKCJI[rodzaj] + 1)
    if (r.razem > MAKS_AKCJI[rodzaj]) return { ok: false, komunikat: `${NAZWA_AKCJI[rodzaj]}: najwyżej ${MAKS_AKCJI[rodzaj]} zamówień w jednej akcji, zawęź filtry (pasuje ${r.razem}).`, n }
    ids = r.ids
  } else {
    const z = idZFormularza(form.getAll('zaznaczone'))
    ids = z.ids
    if (z.zaDuzo || ids.length > MAKS_AKCJI[rodzaj]) return { ok: false, komunikat: `${NAZWA_AKCJI[rodzaj]}: najwyżej ${MAKS_AKCJI[rodzaj]} zamówień w jednej akcji.`, n }
  }
  if (!ids.length) return { ok: false, komunikat: 'Nie zaznaczono żadnego zamówienia.', n }
  const p: ParametryAkcji = {
    status: String(form.get('status') ?? '') || undefined,
    powod: String(form.get('powod') ?? '') || undefined,
    gabaryt: String(form.get('gabaryt') ?? '') || null,
    stanowisko: String(form.get('stanowisko') ?? '') || null,
    nazwa: ctx.user.name,
  }
  const blad = bladParametrow(rodzaj, p)
  if (blad) return { ok: false, komunikat: blad, n }
  if (ids.length >= PROG_TLA[rodzaj]) {
    const id = await zlecWTle(ctx.db, rodzaj, p, ids, ctx.user.id)
    revalidatePath('/zamowienia')
    return { ok: true, komunikat: `${NAZWA_AKCJI[rodzaj]} dla ${ids.length} zamówień idzie w tle. Postęp i raport nad listą.`, wTle: id, n }
  }
  const w = await wykonajOdRazu(ctx.db, rodzaj, p, ids, { id: ctx.user.id, uprawnienia: ctx.permissions })
  revalidatePath('/zamowienia')
  return { ok: w.bledy === 0, komunikat: zdanie(rodzaj, w.ok, w.bledy), bledy: w.pozycje.filter((x) => !x.ok).slice(0, 20), n }
}

/** Postęp akcji w tle (odpytywanie co kilka sekund); tylko akcje tej osoby. */
export async function postepAkcji(id: string): Promise<StanAkcji | null> {
  const ctx = await requireSession()
  return stanAkcji(ctx.db, String(id ?? ''), ctx.user.id)
}
