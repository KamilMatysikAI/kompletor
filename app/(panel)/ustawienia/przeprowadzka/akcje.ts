'use server'
// Ustawienia → Przeprowadzka z BaseLinkera: klucz API BL, tryb próbny, decyzje, import. Tylko z
// uprawnieniem `ustawienia`. BL woła worker (zadanie `przeprowadzka-panel`), nie akcja serwera. Komunikaty: tylko
// nasze teksty (PrzeprowadzkaError), nigdy wartość klucza.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requirePermission } from '@/lib/panel/kontekst'
import { cofnijZakonczenie, zakonczPrzejscie } from '@/lib/przeprowadzka/zakonczenie'
import { zapiszStatusBl } from '@/lib/kanaly/status-bl'
import { katalogZFormularza, MAX_TOKEN_BL, maTokenBl, mapaFirmy, mapaZFormularza, PrzeprowadzkaError, usunTokenBl, zapiszMapeFirmy, zapiszTokenBl, zlecPrzeprowadzke } from '@/lib/przeprowadzka/z-panelu'

const PATH = '/ustawienia/przeprowadzka'

function wroc(q: Record<string, string>): never {
  revalidatePath(PATH)
  revalidatePath('/', 'layout') // klucz BL włącza sekcję „Przejście z BaseLinkera” w menu
  redirect(`${PATH}?${new URLSearchParams(q)}`)
}

const blad = (e: unknown) => (e instanceof PrzeprowadzkaError ? e.message.slice(0, 300) : 'Nie udało się, spróbuj ponownie.')

export async function zapiszKluczBl(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const token = String(form.get('token') ?? '').slice(0, MAX_TOKEN_BL + 1)
  if (!token.trim() && (await maTokenBl(ctx.db)).zapisany) wroc({})
  try {
    await zapiszTokenBl(ctx.db, token, ctx.user.id, process.env)
  } catch (e) {
    if (!(e instanceof PrzeprowadzkaError)) console.error(`[przeprowadzka] zapis klucza BL: ${e instanceof Error ? e.name : 'błąd'}`)
    wroc({ blad: blad(e) })
  }
  wroc({ zapisano: 'Klucz zapisany. Teraz uruchom tryb próbny.' })
}

export async function usunKluczBl(): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  try {
    await usunTokenBl(ctx.db, ctx.user.id)
  } catch (e) {
    console.error(`[przeprowadzka] usunięcie klucza BL: ${e instanceof Error ? e.name : 'błąd'}`)
    wroc({ blad: 'Nie udało się usunąć klucza, spróbuj ponownie.' })
  }
  wroc({ zapisano: 'Klucz BaseLinkera usunięty.' })
}

export async function uruchomProbe(): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  try {
    await zlecPrzeprowadzke(ctx.db, { zapisz: false, actorId: ctx.user.id })
  } catch (e) {
    wroc({ blad: blad(e) })
  }
  wroc({ zapisano: 'Tryb próbny zlecony. Raport pojawi się tu za kilka minut.' })
}

export async function zapiszDecyzje(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  try {
    await zapiszMapeFirmy(ctx.db, mapaZFormularza(form, await mapaFirmy(ctx.db)), ctx.user.id, katalogZFormularza(form))
  } catch (e) {
    wroc({ blad: blad(e) })
  }
  wroc({ zapisano: 'Decyzje zapisane. Uruchom tryb próbny jeszcze raz, żeby zobaczyć raport z nimi.' })
}

export async function uruchomImport(): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  try {
    await zlecPrzeprowadzke(ctx.db, { zapisz: true, actorId: ctx.user.id })
  } catch (e) {
    wroc({ blad: blad(e) })
  }
  wroc({ zapisano: 'Import zlecony. Wynik pojawi się tu po zakończeniu.' })
}

/**
 * „Przejście z BaseLinkera zakończone”: firma po przeprowadzce przestaje być firmą przechodzącą z BL, więc
 * tryb pracy kont włączy z panelu. Uprawnienie jak „Włącz tryb pracy” na pulpicie: `ustawienia` i `kanaly.tryb`.
 */
export async function zakonczPrzejscieZBl(): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  if (!ctx.permissions.has('kanaly.tryb')) wroc({ blad: 'Nie masz uprawnienia do zmiany trybu kanału.' })
  try {
    await zakonczPrzejscie(ctx.db, ctx.user.id, process.env)
  } catch (e) {
    if (!(e instanceof PrzeprowadzkaError)) console.error(`[przeprowadzka] zakończenie przejścia: ${e instanceof Error ? e.name : 'błąd'}`)
    wroc({ blad: blad(e) })
  }
  revalidatePath('/pulpit')
  wroc({ zapisano: 'Przejście z BaseLinkera zakończone. Włącz tryb pracy kont sklepów na pulpicie (karta „Stan kanałów”) albo na ekranie konta.' })
}

export async function cofnijZakonczeniePrzejscia(): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  if (!ctx.permissions.has('kanaly.tryb')) wroc({ blad: 'Nie masz uprawnienia do zmiany trybu kanału.' })
  try {
    await cofnijZakonczenie(ctx.db, ctx.user.id)
  } catch (e) {
    if (!(e instanceof PrzeprowadzkaError)) console.error(`[przeprowadzka] cofnięcie zakończenia: ${e instanceof Error ? e.name : 'błąd'}`)
    wroc({ blad: blad(e) })
  }
  revalidatePath('/pulpit')
  wroc({ zapisano: 'Oznaczenie cofnięte: firma znów przechodzi z BaseLinkera.' })
}

/** wyłącznik i numer statusu BL ustawianego zamówieniom zrealizowanym w Kompletorze (sekcja 6). */
export async function zapiszStatusBlFirmy(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const wlaczony = form.get('wlaczony') === 'tak'
  try {
    await zapiszStatusBl(ctx.db, { wlaczony, statusId: String(form.get('statusId') ?? '').trim().slice(0, 13) }, ctx.user.id)
  } catch (e) {
    wroc({ blad: e instanceof Error && e.message.startsWith('Podaj numer') ? e.message : 'Nie udało się zapisać, spróbuj ponownie.' })
  }
  wroc({ zapisano: wlaczony ? 'Zapisano: Kompletor będzie ustawiał status w BaseLinkerze po wysłaniu.' : 'Zapisano: Kompletor nie zmienia statusów w BaseLinkerze.' })
}
