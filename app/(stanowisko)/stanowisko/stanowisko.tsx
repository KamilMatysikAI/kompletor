'use client'
// Stanowisko pakowania („na sucho” w cieniu, naprawdę na koncie w PRACY) — część w przeglądarce: pole skanu, sesja zamówień, okno pakowania
// (układ jak asystent pakowania BL). Stan zebranych sztuk jest tylko na ekranie; serwer zapisuje „na półce nie
// było” (od razu na listę „Do poprawy w wFirmie”) i wynik ćwiczenia. Produkty nie mają kodów — pozycje dotykiem.
import { zdjecieUrl } from '@/lib/produkty/zdjecia-url'
import { useCallback, useEffect, useRef, useState } from 'react'
import { krokCzytnika, poEsc, poleTekstowe, PUSTY_BUFOR, type BuforCzytnika } from '@/lib/stanowisko/czytnik'
import { GABARYTY, gabarytyDla, ocenaGabarytu, type Gabaryt } from '@/lib/stanowisko/gabaryty'
import { komunikatPrzelaczenia, nastepneWSesji, poBrakuWPracy, poCofnieciuWPracy, podsumowanieSesji, poPrzelaczeniu, poZapisie, type PozycjaSesji } from '@/lib/stanowisko/sesja'
import type { UstawieniaStanowiska } from '@/lib/stanowisko/ustawienia'
import { dolozDoPaczki, otworzZListy, podgladSpakowanego, skanujKarte, usunBrak, zapiszBrak, zapiszWynik, type WynikAkcji, type ZamowienieEkranu } from './akcje'
import { StanDrukarek } from '@/app/(panel)/_komponenty/stan-drukarek'
import { NadaniePrzesylki, zapamietaneStanowisko } from '@/app/(panel)/_komponenty/nadanie-przesylki'
import { ogloszPrzeliczeniePrzesylki } from '@/app/(panel)/_komponenty/przeliczenie-przesylki-zdarzenie'
import { useStanowiskaDruku } from '@/app/(panel)/_komponenty/druk'
import { etykietaOdbioruPoSpakowaniu, stanNadania, utworzPrzesylkeAkcja } from '@/app/(panel)/zamowienia/[id]/akcje-przesylka'
import { PrzyciskiRegulStanowiska } from './przyciski-regul'

type Ton = 'ok' | 'info' | 'blad' | 'czerwona'
interface Pasek {
  tekst: string
  ton: Ton
}

type Brak = { fixId: string; ilosc: number }

type Akcja =
  | { typ: 'ilosc'; klucz: string; przed: number }
  | { typ: 'wszystko'; przed: Record<string, number> }
  | { typ: 'brak'; klucz: string; przed: Brak | null; po: Brak }
  | { typ: 'jednak'; klucz: string; przed: Brak }

type Dialog = { klucz: string; etap: 'wybor' | 'ilosc'; ilosc: number } | { etap: 'nie_spakowano' } | { etap: 'wyczysc' }

interface Okno {
  z: ZamowienieEkranu
  drillId: string
  zebrane: Record<string, number>
  braki: Record<string, Brak>
  historia: Akcja[]
  uwagiOk: boolean
  krok: 'pozycje' | 'gabaryt' | 'zapisane' | 'podsumowanie'
  dialog: Dialog | null
  pasek: Pasek | null
  zapisano: string | null
  zajety: boolean
  /** gabaryt wybrany przy „Spakowane” — przycisk „Utwórz przesyłkę” na ekranie zapisu bierze go od razu. */
  gabaryt?: Gabaryt | null
  spakowane?: boolean
  /** 19.11.2026: okno otwarte ponownie dla już spakowanego zamówienia: sam podgląd, bez zapisu. */
  podglad?: boolean
}

/** Potwierdzenie zapisu po przejściu do następnego zamówienia: ok. 2 s, z możliwością zostania przy poprzednim. */
const POTWIERDZENIE_MS = 2000

const ilosc = (n: number, j: 'szt' | 'g') => (j === 'g' ? `${n} g` : `${n} szt.`)

/** Tryb konta raz przy zamówieniu: pakowanie próbne (konto „Tylko podgląd”) dostaje plakietkę, zwykłe — nic. */
function Plakietka({ tryb }: { tryb: 'CIEN' | 'PRACA' }) {
  return tryb === 'CIEN' ? <span className="st-tag sucho">PRÓBNE</span> : null
}

/** Następne zamówienie z kolejki pakowania (pusty stan stanowiska). */
export interface NastepneDoSpakowania {
  id: string
  numer: string
  przewoznik: string
  tryb: 'CIEN' | 'PRACA'
  koszyk: string | null
  pozycji: number
}

function Miniatura({ zdjecie }: { zdjecie?: string | null }) {
  // główne zdjęcie produktu; bez zdjęcia zaślepka „brak” w stałym miejscu
  if (zdjecie) return <img className="st-thumb" src={zdjecieUrl(zdjecie, 'm')} alt="" width={96} height={96} loading="lazy" />
  return (
    <span className="st-thumb" aria-hidden="true">
      brak
    </span>
  )
}

/**
 * `onZamknijNakladke` = stanowisko w oknie nad kolejką pakowania: bez pola skanu, pierwsze zamówienie
 * otwiera się samo, a X zamyka całość. Bez niego: samodzielna strona /stanowisko.
 */
export function Stanowisko({
  sesjaStart,
  ustawienia,
  kto,
  firma,
  onZamknijNakladke,
  nastepne = [],
  przykladKodu = 'SD48213/1',
}: {
  sesjaStart: PozycjaSesji[]
  ustawienia: UstawieniaStanowiska
  kto: string
  firma: string
  onZamknijNakladke?: () => void
  /** Samodzielne stanowisko: kilka pierwszych zamówień z kolejki do kliknięcia, gdy nie ma czytnika. */
  nastepne?: NastepneDoSpakowania[]
  /** Przykład kodu karty w polu skanu, z przedrostka konta firmy („SH48083/1”). */
  przykladKodu?: string
}) {
  const wNakladce = onZamknijNakladke !== undefined
  const [sesja, setSesja] = useState<PozycjaSesji[]>(sesjaStart)
  const [pasek, setPasek] = useState<Pasek | null>(null)
  const [okno, setOkno] = useState<Okno | null>(null)
  const [skan, setSkan] = useState('')
  const [zajety, setZajety] = useState(false)
  const [odliczanie, setOdliczanie] = useState<number | null>(null)
  const stanowiskaDruku = useStanowiskaDruku()
  // 19.11.2026: pasek na dole ekranu ze stanem etykiety ostatnich paczek (niezależny od okna pakowania)
  const [etykiety, setEtykiety] = useState<{ id: string; numer: string; stan: 'trwa' | 'ok' | 'blad'; tekst: string }[]>([])
  const ustawEtykiete = useCallback((id: string, numer: string, stan: 'trwa' | 'ok' | 'blad', tekst: string) => {
    setEtykiety((l) => [...l.filter((e) => e.id !== id), { id, numer, stan, tekst }].slice(-4))
    if (stan === 'ok') setTimeout(() => setEtykiety((l) => l.filter((e) => !(e.id === id && e.stan === 'ok'))), 12000)
  }, [])
  /** Przejście do następnego zamówienia po zapisie: tekst potwierdzenia i okno, do którego można wrócić. */
  const [przejscie, setPrzejscie] = useState<{ tekst: string; poprzednie: Okno } | null>(null)
  const pole = useRef<HTMLInputElement>(null)
  const przejscieTeraz = useRef(przejscie)
  useEffect(() => {
    przejscieTeraz.current = przejscie
  }, [przejscie])
  const naglowekOkna = useRef<HTMLButtonElement>(null)
  // generacja otwierania: Esc, X, usunięcie z listy albo wybór innego zamówienia porzucają odpowiedź serwera w locie
  const generacja = useRef(0)
  const sesjaTeraz = useRef(sesja)
  useEffect(() => {
    sesjaTeraz.current = sesja
  }, [sesja])

  const doPola = useCallback(() => setTimeout(() => pole.current?.focus(), 0), [])

  // sesja w adresie (?z=…): odświeżenie strony nie gubi listy; kontrakt z kolejką pakowania
  useEffect(() => {
    const ids = sesja.map((s) => s.id).join(',')
    const url = new URL(window.location.href)
    if (ids) url.searchParams.set(wNakladce ? 'pakuj' : 'z', ids)
    else url.searchParams.delete(wNakladce ? 'pakuj' : 'z')
    window.history.replaceState(window.history.state, '', url)
  }, [sesja, wNakladce])

  const dodajDoSesji = useCallback((p: PozycjaSesji) => {
    setSesja((s) => (s.some((x) => x.id === p.id) ? s.map((x) => (x.id === p.id ? { ...x, ...p, stan: x.stan === 'spakowane' ? x.stan : p.stan } : x)) : [...s, p]))
  }, [])

  const otworzOkno = useCallback(
    (w: Extract<WynikAkcji, { typ: 'ok' }>, printId: string | null, pojedynczy = false, pasek: Pasek | null = null) => {
      const braki: Record<string, Brak> = {}
      for (const b of w.cwiczenie.braki) braki[b.klucz] = { fixId: b.fixId, ilosc: b.ilosc }
      dodajDoSesji({ id: w.zamowienie.id, numer: w.zamowienie.numer, tryb: w.zamowienie.tryb, printId, stan: 'czeka', komunikat: null, czerwona: false, ...(pojedynczy ? { pojedynczy } : {}) })
      setOdliczanie(null)
      setPrzejscie(null)
      setOkno({ z: w.zamowienie, drillId: w.cwiczenie.drillId, zebrane: {}, braki, historia: [], uwagiOk: false, krok: 'pozycje', dialog: null, pasek, zapisano: null, zajety: false })
    },
    [dodajDoSesji],
  )

  const pokazBlokade = useCallback(
    (w: Extract<WynikAkcji, { typ: 'blokada' }>) => {
      if (w.zamowienie) {
        dodajDoSesji({
          id: w.zamowienie.id,
          numer: w.zamowienie.numer,
          tryb: w.zamowienie.tryb,
          printId: null,
          stan: w.blokada.rodzaj === 'spakowane' ? 'spakowane' : 'blokada',
          komunikat: w.blokada.komunikat,
          czerwona: w.blokada.czerwona,
        })
      }
      return { tekst: w.blokada.komunikat, ton: (w.blokada.czerwona ? 'czerwona' : 'blad') as Ton }
    },
    [dodajDoSesji],
  )

  // ─── skan w polu (okno zamknięte) ───
  async function wyslijSkan(e?: React.FormEvent) {
    e?.preventDefault()
    const t = skan.trim()
    if (zajety) return
    if (!t) {
      setPasek({ tekst: `Zeskanuj albo wpisz kod z karty zamówienia (np. ${przykladKodu}) lub z koszyka.`, ton: 'blad' })
      doPola()
      return
    }
    setZajety(true)
    try {
      const w = await skanujKarte(t, false)
      setSkan('')
      if (w.typ === 'koszyk') {
        setPasek({ tekst: w.tekst, ton: w.ton })
        doPola()
      } else if (w.typ === 'ok') {
        setPasek({ tekst: `${w.zamowienie.numer}: otwarte do pakowania.`, ton: 'ok' })
        otworzOkno(w, null, true)
      } else if (w.typ === 'blokada') {
        setPasek(pokazBlokade(w))
        doPola()
      }
    } catch {
      setPasek({ tekst: 'Brak połączenia z serwerem — spróbuj jeszcze raz.', ton: 'blad' })
      doPola()
    } finally {
      setZajety(false)
    }
  }

  // ─── skan w trakcie pakowania: czytnik „pisze” szybko i kończy Enterem — dokłada zamówienie do sesji ───
  const bufor = useRef<BuforCzytnika>(PUSTY_BUFOR)
  const oknoOtwarte = okno !== null
  useEffect(() => {
    if (!oknoOtwarte) return
    const onKey = (e: KeyboardEvent) => {
      // fokus na checkboksie „Przeczytane i zrobione” albo przycisku nie blokuje czytnika — tylko pola tekstowe
      const el = e.target
      const cel = el instanceof HTMLInputElement ? { tagName: 'INPUT', type: el.type } : el instanceof HTMLElement ? { tagName: el.tagName } : null
      const k = krokCzytnika(bufor.current, { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, teraz: performance.now(), wPoluTekstowym: poleTekstowe(cel) })
      bufor.current = k.bufor
      if (k.skan !== null) {
        e.preventDefault()
        void skanWTrakcie(k.skan)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // skanWTrakcie czyta tylko setterami — bez zależności
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oknoOtwarte])

  // numer ostatniego skanu w trakcie; przełączenie bierze tylko odpowiedź na najnowszy skan
  const skanNr = useRef(0)
  // po przełączeniu komunikat ma być widać: okno przewinięte przy poprzednim zamówieniu (390 px) wraca do paska
  const doPaska = useRef(false)
  const pasekOkna = okno?.pasek ?? null
  useEffect(() => {
    if (!doPaska.current || !pasekOkna) return
    doPaska.current = false
    document.querySelector('.st-okno .st-okno-tresc .st-pasek')?.scrollIntoView({ block: 'nearest' })
  }, [pasekOkna])

  /** Przełączenie okna na inne zamówienie (skan jego karty albo koszyka): odłożone zostaje niespakowane na liście. */
  function przelacz(w: Extract<WynikAkcji, { typ: 'ok' }>, printId: string | null) {
    const o = oknoTeraz.current
    if (o?.z.id === w.zamowienie.id) {
      ustawPasekOkna({ tekst: `${w.zamowienie.numer}: to zamówienie jest już otwarte.`, ton: 'info' })
      return
    }
    generacja.current++
    const nowa: PozycjaSesji = { id: w.zamowienie.id, numer: w.zamowienie.numer, tryb: w.zamowienie.tryb, printId, stan: 'czeka', komunikat: null, czerwona: false }
    setSesja((s) => (o ? poPrzelaczeniu(s, o.z.id, nowa) : s))
    const tekst = komunikatPrzelaczenia(
      w.zamowienie.numer,
      o
        ? {
            numer: o.z.numer,
            zapisane: o.krok === 'zapisane' || o.krok === 'podsumowanie',
            odhaczone: o.uwagiOk || Object.values(o.zebrane).some((n) => n > 0),
            braki: Object.keys(o.braki).length > 0,
          }
        : null,
    )
    doPaska.current = true
    otworzOkno(w, printId, false, { tekst, ton: o && o.krok !== 'zapisane' && o.krok !== 'podsumowanie' ? 'info' : 'ok' })
  }

  async function skanWTrakcie(t: string) {
    const nr = ++skanNr.current
    const g = generacja.current
    // odpowiedź na starszy skan albo okno zamknięte / zmienione w międzyczasie: bez przełączania
    const nieaktualne = () => nr !== skanNr.current || g !== generacja.current
    try {
      const o = oknoTeraz.current
      if (o?.zajety) {
        ustawPasekOkna({ tekst: 'Chwila, zapisuję bieżące zamówienie. Zeskanuj jeszcze raz za moment.', ton: 'blad' })
        return
      }
      const w = await skanujKarte(t, true, o?.z.id ?? null)
      if (w.typ === 'koszyk') {
        // koszyk przypisany bieżącemu zamówieniu — widać go w nagłówku okna
        const { koszyk, orderId } = w
        if (koszyk && orderId) setOkno((o) => (o && o.z.id === orderId ? { ...o, z: { ...o.z, koszyk }, pasek: { tekst: w.tekst, ton: w.ton } } : o))
        else ustawPasekOkna({ tekst: w.tekst, ton: w.ton })
      } else if (w.typ === 'ok') {
        // koszyk innego zamówienia — przełączenie na zamówienie z koszyka (otwarte zostaje w swoim koszyku)
        if (!nieaktualne()) przelacz(w, null)
      } else if (w.typ === 'do_sesji') {
        // karta innego zamówienia przełącza okno; ta sama karta nic nie zmienia
        if (oknoTeraz.current?.z.id === w.zamowienie.id) {
          ustawPasekOkna({ tekst: `${w.zamowienie.numer}: to zamówienie jest już otwarte.`, ton: 'info' })
          return
        }
        const otw = await otworzZListy(w.zamowienie.id, w.printId)
        if (nieaktualne()) return
        if (otw.typ === 'ok') przelacz(otw, w.printId)
        else if (otw.typ === 'blokada') ustawPasekOkna(pokazBlokade(otw))
      } else if (w.typ === 'blokada') {
        ustawPasekOkna(pokazBlokade(w))
      }
    } catch {
      ustawPasekOkna({ tekst: 'Brak połączenia z serwerem — zeskanuj jeszcze raz.', ton: 'blad' })
    }
  }

  const ustawPasekOkna = (p: Pasek | null) => setOkno((o) => (o ? { ...o, pasek: p } : o))

  async function otworzZSesji(p: PozycjaSesji) {
    if (okno?.z.id === p.id) return
    // podgląd spakowanego (19.11.2026) niczego nie edytuje, więc nie blokuje przejścia do kolejnego zamówienia
    if (okno && !okno.podglad && okno.krok !== 'zapisane' && okno.krok !== 'podsumowanie' && (Object.keys(okno.zebrane).length || okno.historia.length)) {
      ustawPasekOkna({ tekst: 'Najpierw zapisz bieżące zamówienie („Spakowano” albo „Nie spakowano”) albo zamknij okno ✕.', ton: 'blad' })
      return
    }
    const g = ++generacja.current
    try {
      const w = await otworzZListy(p.id, p.printId)
      if (g !== generacja.current) return
      if (w.typ === 'ok') otworzOkno(w, p.printId)
      else if (w.typ === 'blokada') {
        const pk = pokazBlokade(w)
        if (okno) ustawPasekOkna(pk)
        else setPasek(pk)
      }
    } catch {
      if (g === generacja.current) setPasek({ tekst: 'Brak połączenia z serwerem — spróbuj jeszcze raz.', ton: 'blad' })
    }
  }

  function usunZSesji(id: string) {
    generacja.current++
    setSesja((s) => s.filter((x) => x.id !== id))
    if (okno?.z.id !== id) return
    // w nakładce X przy zamówieniu usuwa tylko je z sesji; zamknięcie całości to X w nagłówku
    if (wNakladce) {
      setOkno(null)
      setPrzejscie(null)
    } else zamknijOkno()
  }

  const zamknijOkno = useCallback(() => {
    generacja.current++
    setOkno(null)
    setOdliczanie(null)
    setPrzejscie(null)
    if (onZamknijNakladke) onZamknijNakladke()
    else doPola()
  }, [doPola, onZamknijNakladke])

  /**
   * Otwiera następne zamówienie „czeka” z listy. Zablokowane w międzyczasie (np. brak doszedł po wczytaniu sesji)
   * oznacza na liście i idzie dalej. `koniec` = nie ma już nic do pakowania, `przerwane` = w trakcie zapytania ktoś
   * zamknął okno albo wybrał coś innego (odpowiedź serwera porzucona). Sieć w połowie = wyjątek.
   */
  const otworzNastepne = useCallback(
    async (lista: PozycjaSesji[], odId: string | null): Promise<'otwarte' | 'koniec' | 'przerwane'> => {
      const g = generacja.current
      let l = lista
      for (let n = nastepneWSesji(l, odId); n; n = nastepneWSesji(l, odId)) {
        const id = n.id
        const w = await otworzZListy(id, n.printId)
        if (g !== generacja.current) return 'przerwane'
        if (w.typ === 'ok') {
          otworzOkno(w, n.printId)
          return 'otwarte'
        }
        if (w.typ !== 'blokada') return 'koniec'
        const zmiana = { stan: (w.blokada.rodzaj === 'spakowane' ? 'spakowane' : 'blokada') as PozycjaSesji['stan'], komunikat: w.blokada.komunikat, czerwona: w.blokada.czerwona }
        l = l.map((x) => (x.id === id ? { ...x, ...zmiana } : x))
        setSesja((s) => s.map((x) => (x.id === id ? { ...x, ...zmiana } : x)))
      }
      return 'koniec'
    },
    [otworzOkno],
  )

  // okno nad kolejką: „Pakuj zaznaczone” od razu otwiera pierwsze zamówienie (ref: StrictMode woła efekt dwa razy)
  const startNakladki = useRef(false)
  useEffect(() => {
    if (!wNakladce || startNakladki.current) return
    startNakladki.current = true
    const g = generacja.current
    otworzNastepne(sesjaStart, null).catch(() => {
      if (g === generacja.current) setPasek({ tekst: 'Brak połączenia z serwerem — otwórz zamówienie z listy.', ton: 'blad' })
    })
  }, [wNakladce, sesjaStart, otworzNastepne])

  // nowe okno w nakładce przejmuje fokus z przycisku na kolejce pod spodem
  const idOkna = okno?.z.id ?? null
  useEffect(() => {
    if (wNakladce && idOkna) naglowekOkna.current?.focus({ preventScroll: true })
  }, [wNakladce, idOkna])

  // długa sesja: bieżące zamówienie zawsze widać w lewej kolumnie
  useEffect(() => {
    if (idOkna) document.querySelector('.st-okno-sesja .aktywne')?.scrollIntoView({ block: 'nearest' })
  }, [idOkna])

  // potwierdzenie zapisu znika samo
  useEffect(() => {
    if (!przejscie) return
    const t = setTimeout(() => setPrzejscie(null), POTWIERDZENIE_MS)
    return () => clearTimeout(t)
  }, [przejscie])

  const zostanPrzyPoprzednim = useCallback(() => {
    const p = przejscieTeraz.current
    if (p) setOkno(p.poprzednie)
    setPrzejscie(null)
  }, [])

  // w nakładce Esc zamyka tylko okno zamówienia (widok listy); nakładkę zamyka X albo drugi Esc z widoku listy
  const doListy = useCallback(() => {
    generacja.current++
    setOkno(null)
    setOdliczanie(null)
    setPrzejscie(null)
  }, [])

  // Esc: najpierw okienko, potem okno pakowania. Decyzja z bieżącego stanu w ref — updatery setOkno czyste (StrictMode)
  const oknoTeraz = useRef<Okno | null>(okno)
  useEffect(() => {
    oknoTeraz.current = okno
  }, [okno])
  useEffect(() => {
    if (!oknoOtwarte && !wNakladce) return
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const o = oknoTeraz.current
      const co = poEsc(o, Boolean(przejscieTeraz.current) && !o?.historia.length, wNakladce)
      if (co === 'zostan') zostanPrzyPoprzednim()
      else if (co === 'lista') doListy()
      else if (co === 'dialog') setOkno((o) => (o ? { ...o, dialog: null } : o))
      else if (co === 'gabaryt') setOkno((o) => (o ? { ...o, krok: 'pozycje' } : o))
      else zamknijOkno()
    }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [oknoOtwarte, wNakladce, zamknijOkno, zostanPrzyPoprzednim, doListy])

  // powrót do skanu po zapisie (ustawienie firmy, domyślnie 3 s) z „Zostań tutaj”
  useEffect(() => {
    if (odliczanie === null) return
    if (odliczanie <= 0) {
      zamknijOkno()
      return
    }
    const t = setTimeout(() => setOdliczanie((n) => (n === null ? null : n - 1)), 1000)
    return () => clearTimeout(t)
  }, [odliczanie, zamknijOkno])

  // ─── pozycje ───
  function zmien(klucz: string, nowa: number) {
    setOkno((o) => {
      if (!o || o.krok !== 'pozycje') return o
      const p = o.z.pozycje.find((x) => x.klucz === klucz)
      if (!p) return o
      const max = p.ilosc - (o.braki[klucz]?.ilosc ?? 0)
      const v = Math.max(0, Math.min(max, nowa))
      const przed = o.zebrane[klucz] ?? 0
      if (v === przed) return o
      return { ...o, zebrane: { ...o.zebrane, [klucz]: v }, historia: [...o.historia, { typ: 'ilosc', klucz, przed }], pasek: null }
    })
  }

  function wszystkoWKoszyku() {
    setOkno((o) => {
      if (!o) return o
      const zebrane: Record<string, number> = {}
      for (const p of o.z.pozycje) zebrane[p.klucz] = p.ilosc - (o.braki[p.klucz]?.ilosc ?? 0)
      return { ...o, zebrane, historia: [...o.historia, { typ: 'wszystko', przed: o.zebrane }], pasek: { tekst: 'Wszystko w koszyku. Czego nie było na półce (kratka BRAK na karcie) — „Nie ma w koszyku” przy tej pozycji.', ton: 'info' } }
    })
  }

  async function zapiszBrakPozycji(klucz: string, ile: number) {
    const o = okno
    if (!o) return
    setOkno({ ...o, zajety: true })
    try {
      const r = await zapiszBrak(o.drillId, klucz, ile)
      setOkno((x) => {
        if (!x) return x
        if (!r.ok) return { ...x, zajety: false, dialog: null, pasek: { tekst: r.komunikat, ton: 'blad' } }
        const p = x.z.pozycje.find((y) => y.klucz === klucz)!
        const zeb = Math.min(x.zebrane[klucz] ?? 0, p.ilosc - r.wynik.ilosc)
        const przed = x.braki[klucz] ?? null
        const braki = { ...x.braki, [klucz]: { fixId: r.wynik.fixId, ilosc: r.wynik.ilosc } }
        const zebrane = { ...x.zebrane, [klucz]: zeb }
        // PRACA: lista z rdzenia, bo brak składnika wyjmuje z paczki cały zestaw
        const stan = x.z.tryb === 'PRACA' && r.wynik.doZebrania ? poBrakuWPracy({ pozycje: x.z.pozycje, braki, zebrane }, r.wynik.doZebrania) : { pozycje: x.z.pozycje, zebrane }
        const tekst =
          x.z.tryb === 'CIEN'
            ? `${p.nazwa}: „na półce nie było” ${ilosc(r.wynik.ilosc, p.jednostka)} — na liście „Do poprawy w wFirmie”.`
            : r.wynik.zestawPoza
              ? `${p.nazwa}: brak zapisany. Zestaw nie wychodzi: jego pozostałe składniki odłóż na półkę, spakuj resztę.`
              : `${p.nazwa}: brak ${ilosc(r.wynik.ilosc, p.jednostka)} zapisany w zamówieniu, biuro zdecyduje, co dalej.`
        return {
          ...x,
          z: { ...x.z, pozycje: stan.pozycje },
          zajety: false,
          dialog: null,
          braki,
          zebrane: stan.zebrane,
          // PRACA: brak jest już w zamówieniu, „Cofnij” go nie zdejmie (serwer odmawia mniejszej ilości); cofa „Jednak jest”
          historia: x.z.tryb === 'PRACA' ? x.historia : [...x.historia, { typ: 'brak', klucz, przed, po: { fixId: r.wynik.fixId, ilosc: r.wynik.ilosc } }],
          pasek: { tekst, ton: 'info' },
        }
      })
    } catch {
      setOkno((x) => (x ? { ...x, zajety: false, pasek: { tekst: 'Brak połączenia z serwerem — nic nie zapisano.', ton: 'blad' } } : x))
    }
  }

  async function jednakJest(klucz: string) {
    const o = okno
    const b = o?.braki[klucz]
    if (!o || !b) return
    setOkno({ ...o, zajety: true })
    try {
      const r = await usunBrak(o.drillId, b.fixId)
      setOkno((x) => {
        if (!x) return x
        if (!r.ok) return { ...x, zajety: false, pasek: { tekst: r.komunikat, ton: 'blad' } }
        const braki = { ...x.braki }
        delete braki[klucz]
        // PRACA: brak cofnięty w zamówieniu; lista z serwera, bo zestaw wraca do paczki cały
        if (x.z.tryb === 'PRACA' && r.wynik.pozycje) {
          const nazwa = x.z.pozycje.find((p) => p.klucz === klucz)?.nazwa ?? 'Pozycja'
          const stan = poCofnieciuWPracy({ pozycje: x.z.pozycje, braki, zebrane: x.zebrane }, r.wynik.pozycje)
          const tekst = r.wynik.wrocilo ? `${nazwa}: brak cofnięty, towar wraca do paczki — zbierz go.` : `${nazwa}: brak cofnięty, ale towaru nie da się już przypisać do tej paczki — biuro zdecyduje, co dalej.`
          return { ...x, z: { ...x.z, pozycje: stan.pozycje }, zajety: false, braki, zebrane: stan.zebrane, pasek: { tekst, ton: 'info' } }
        }
        return { ...x, zajety: false, braki, historia: [...x.historia, { typ: 'jednak', klucz, przed: b }], pasek: null }
      })
    } catch {
      setOkno((x) => (x ? { ...x, zajety: false, pasek: { tekst: 'Brak połączenia z serwerem — nic nie zmieniono.', ton: 'blad' } } : x))
    }
  }

  // „Jednak jest w paczce” przy ramce „Brakuje, nie pakuj” — serwer dopisuje towar do paczki, gdy stan pozwala
  async function jednakWPaczce(orderLineId: string) {
    const o = okno
    if (!o || o.zajety) return
    setOkno({ ...o, zajety: true })
    try {
      const r = await dolozDoPaczki(o.drillId, orderLineId)
      setOkno((x) => {
        if (!x) return x
        if (!r.ok) return { ...x, zajety: false, pasek: { tekst: r.komunikat, ton: 'blad' } }
        const nazwa = x.z.brakujace.find((b) => b.orderLineId === orderLineId)?.nazwa ?? 'Pozycja'
        const stan = poCofnieciuWPracy({ pozycje: x.z.pozycje, braki: x.braki, zebrane: x.zebrane }, r.wynik.pozycje)
        const tekst = r.wynik.units > 0 ? `${nazwa}: dołożone do paczki — zbierz pełną ilość.` : `${nazwa}: brak był już zamknięty.`
        return { ...x, z: { ...x.z, pozycje: stan.pozycje, brakujace: r.wynik.brakujace }, zajety: false, zebrane: stan.zebrane, pasek: { tekst, ton: 'info' } }
      })
    } catch {
      setOkno((x) => (x ? { ...x, zajety: false, pasek: { tekst: 'Brak połączenia z serwerem — nic nie zmieniono.', ton: 'blad' } } : x))
    }
  }

  async function cofnij() {
    const o = okno
    if (!o || !o.historia.length || o.zajety) return
    const a = o.historia[o.historia.length - 1]!
    const historia = o.historia.slice(0, -1)
    if (a.typ === 'ilosc') return setOkno({ ...o, historia, zebrane: { ...o.zebrane, [a.klucz]: a.przed }, pasek: null })
    if (a.typ === 'wszystko') return setOkno({ ...o, historia, zebrane: a.przed, pasek: null })
    setOkno({ ...o, zajety: true })
    try {
      if (a.typ === 'brak') {
        if (a.przed) {
          const r = await zapiszBrak(o.drillId, a.klucz, a.przed.ilosc)
          if (!r.ok) throw new Error(r.komunikat)
          setOkno((x) => (x ? { ...x, zajety: false, historia, braki: { ...x.braki, [a.klucz]: { fixId: r.wynik.fixId, ilosc: r.wynik.ilosc } }, pasek: null } : x))
        } else {
          const r = await usunBrak(o.drillId, a.po.fixId)
          if (!r.ok) throw new Error(r.komunikat)
          setOkno((x) => {
            if (!x) return x
            const braki = { ...x.braki }
            delete braki[a.klucz]
            return { ...x, zajety: false, historia, braki, pasek: null }
          })
        }
      } else {
        const r = await zapiszBrak(o.drillId, a.klucz, a.przed.ilosc)
        if (!r.ok) throw new Error(r.komunikat)
        setOkno((x) => (x ? { ...x, zajety: false, historia, braki: { ...x.braki, [a.klucz]: { fixId: r.wynik.fixId, ilosc: r.wynik.ilosc } }, pasek: null } : x))
      }
    } catch (e) {
      setOkno((x) => (x ? { ...x, zajety: false, pasek: { tekst: e instanceof Error && e.message ? e.message : 'Nie udało się cofnąć.', ton: 'blad' } } : x))
    }
  }

  async function wyczysc() {
    const o = okno
    if (!o) return
    setOkno({ ...o, zajety: true, dialog: null })
    try {
      // PRACA: brak jest już w zamówieniu, stanowisko go nie cofa; czyści się tylko to, co zebrane w tym oknie
      const wPracy = o.z.tryb === 'PRACA'
      if (!wPracy) {
        for (const b of Object.values(o.braki)) {
          const r = await usunBrak(o.drillId, b.fixId)
          if (!r.ok) throw new Error(r.komunikat)
        }
      }
      setOkno((x) => (x ? { ...x, zajety: false, zebrane: {}, braki: wPracy ? x.braki : {}, historia: [], uwagiOk: false, pasek: { tekst: 'Wyczyszczone — zbieraj od początku.', ton: 'info' } } : x))
    } catch (e) {
      setOkno((x) => (x ? { ...x, zajety: false, pasek: { tekst: e instanceof Error && e.message ? e.message : 'Nie udało się wyczyścić.', ton: 'blad' } } : x))
    }
  }

  /**
   * Poprawka z 19.11.2026: po „Spakowane” na koncie w pracy przesyłka i druk etykiety ruszają same, bez przycisku
   * (w sesji ekran „zapisane” z przyciskiem jest pomijany). Domyślne wymiary i waga firmy są tu potwierdzone z góry,
   * jak w ustawieniach przewoźnika. Błąd idzie na pasek; przesyłkę da się wtedy utworzyć z karty zamówienia.
   */
  function nadajPoSpakowaniu(orderId: string, numer: string, gabaryt: Gabaryt | null) {
    const blad = (powod: string) => ustawEtykiete(orderId, numer, 'blad', `etykieta nie wyszła: ${powod}`)
    void (async () => {
      try {
        const stan = await stanNadania(orderId)
        if (!stan) return
        if (stan.nieDotyczy) {
          // odbiór osobisty — etykieta odbioru do naklejenia na paczkę, tym samym torem druku
          const w = await etykietaOdbioruPoSpakowaniu(orderId, zapamietaneStanowisko(stanowiskaDruku))
          if (!w) return
          if (w.blad || !w.druk) ustawEtykiete(orderId, numer, 'blad', `etykieta odbioru nie wyszła: ${w.blad ?? 'brak zlecenia druku'}`)
          else ustawEtykiete(orderId, numer, 'ok', `etykieta odbioru wysłana do druku (${w.druk.stanowisko})`)
          return
        }
        if (stan.przesylka && stan.przesylka.stan !== 'BLAD' && stan.przesylka.stan !== 'ANULOWANA') return
        if (stan.powod) return blad(stan.powod)
        ustawEtykiete(orderId, numer, 'trwa', 'tworzę przesyłkę i etykietę…')
        const w = await utworzPrzesylkeAkcja(orderId, gabaryt, ['wymiary_domyslne', 'waga_domyslna'], zapamietaneStanowisko(stanowiskaDruku))
        // inne ostrzeżenia czekają na potwierdzenie, to nie jest błąd nadania. Blok przesyłki
        // w oknie (gdy jest otwarty) dostaje świeże teksty z odmowy, a pasek mówi, co zrobić, także gdy okna już nie ma
        if (w.doPotwierdzenia?.length) {
          ogloszPrzeliczeniePrzesylki({ orderId, doPotwierdzenia: w.doPotwierdzenia })
          ustawEtykiete(orderId, numer, 'blad', 'przesyłka czeka na potwierdzenie (nic nie nadano): w zamówieniu zaznacz pola w „Sprawdź przed nadaniem” i kliknij „Potwierdzam i tworzę przesyłkę”')
        }
        else if (w.blad) blad(w.blad)
        else if (!w.druk) ustawEtykiete(orderId, numer, 'blad', `${w.info ?? 'przesyłka utworzona'} Etykieta nie poszła do druku.`)
        else ustawEtykiete(orderId, numer, 'ok', `etykieta wysłana do druku (${w.druk.stanowisko})`)
      } catch {
        blad('brak połączenia z serwerem')
      }
    })()
  }

  /** Podgląd spakowanego zamówienia w oknie pakowania: pozycje, przesyłka i ponowny druk etykiety; niczego nie zapisuje. */
  async function pokazSpakowane(p: PozycjaSesji) {
    try {
      const z = await podgladSpakowanego(p.id)
      if (!z) {
        setPasek({ tekst: `${p.numer}: nie udało się wczytać zamówienia, otwórz jego kartę.`, ton: 'blad' })
        return
      }
      setOdliczanie(null)
      setOkno({ z, drillId: '', zebrane: Object.fromEntries(z.pozycje.map((x) => [x.klucz, x.ilosc])), braki: {}, historia: [], uwagiOk: true, krok: 'pozycje', dialog: null, pasek: { tekst: `${z.numer}: już spakowane. Podgląd: przyciski są zablokowane.`, ton: 'info' }, zapisano: null, zajety: true, gabaryt: null, spakowane: true, podglad: true })
    } catch {
      setPasek({ tekst: 'Brak połączenia z serwerem — spróbuj jeszcze raz.', ton: 'blad' })
    }
  }

  async function zakoncz(wynik: 'SPAKOWANE' | 'NIE_SPAKOWANO', gabaryt: Gabaryt | null) {
    const o = okno
    if (!o || o.zajety) return
    setOkno({ ...o, zajety: true, dialog: null })
    const g = generacja.current
    try {
      const r = await zapiszWynik({ drillId: o.drillId, wynik, gabaryt, zebrane: o.zebrane, uwagiOdhaczone: o.uwagiOk })
      if (!r.ok) {
        setOkno((x) => (x ? { ...x, zajety: false, krok: 'pozycje', pasek: { tekst: r.komunikat, ton: 'blad' } } : x))
        return
      }
      const tekst = wynik === 'SPAKOWANE' ? `${o.z.numer}: spakowane${o.z.tryb === 'CIEN' ? ' próbnie' : ''}${gabaryt ? ` (${GABARYTY[gabaryt]})` : ''}.` : `${o.z.numer}: zapisane „Nie spakowano”.`
      const zBrakiem = Object.keys(o.braki).length > 0
      const lista = sesjaTeraz.current.map((x) => (x.id === o.z.id ? { ...x, stan: (wynik === 'SPAKOWANE' ? 'spakowane' : 'nie_spakowano') as PozycjaSesji['stan'], komunikat: null, zBrakiem } : x))
      setSesja(lista)
      const zapisane: Okno = { ...o, zajety: false, dialog: null, krok: 'zapisane', zapisano: tekst, pasek: null, gabaryt, spakowane: wynik === 'SPAKOWANE' }
      // w nakładce pasek widać tylko w widoku listy, gdzie komunikat o poprzednim zamówieniu byłby nieaktualny
      if (!wNakladce) setPasek({ tekst, ton: 'ok' })
      const nadaj = wynik === 'SPAKOWANE' && o.z.tryb !== 'CIEN'
      if (g !== generacja.current) {
        // zapis się udał, ale okno już zamknięte albo zmienione: nie otwieramy go z powrotem, tylko zdejmujemy „zajęte”
        setOkno((x) => (x && x.z.id === o.z.id ? zapisane : x))
        if (nadaj) nadajPoSpakowaniu(o.z.id, o.z.numer, gabaryt)
        return
      }
      if (poZapisie(lista, o.z.id) !== 'zapisane') {
        await poZapisieWSesji(lista, zapisane, tekst)
        if (nadaj) nadajPoSpakowaniu(o.z.id, o.z.numer, gabaryt)
      } else {
        setOkno(zapisane)
        setOdliczanie(ustawienia.powrotDoSkanu ? ustawienia.powrotPoSekundach : null)
        if (nadaj) nadajPoSpakowaniu(o.z.id, o.z.numer, gabaryt)
      }
    } catch {
      setOkno((x) => (x ? { ...x, zajety: false, pasek: { tekst: 'Brak połączenia z serwerem — wynik niezapisany, spróbuj jeszcze raz.', ton: 'blad' } } : x))
    }
  }

  // sesja: od razu następne zamówienie, potwierdzenie krótkim komunikatem; ostatnie = podsumowanie
  async function poZapisieWSesji(lista: PozycjaSesji[], zapisane: Okno, tekst: string) {
    setOkno(zapisane)
    const g = generacja.current
    try {
      const co = await otworzNastepne(lista, zapisane.z.id)
      if (co === 'otwarte') setPrzejscie({ tekst, poprzednie: zapisane })
      else if (co === 'koniec') setOkno({ ...zapisane, krok: 'podsumowanie' })
    } catch {
      if (g === generacja.current) setOkno({ ...zapisane, pasek: { tekst: 'Brak połączenia z serwerem — następne zamówienie otwórz z listy.', ton: 'blad' } })
    }
  }

  const wrocNapis = wNakladce ? 'Wróć do kolejki' : 'Wróć do skanu'
  const spakowanych = sesja.filter((x) => x.stan === 'spakowane').length
  const zKolejki = !wNakladce && sesjaStart.length > 0

  return (
    <div className={wNakladce ? 'st-root st-nakladka' : 'st-page'}>
      {etykiety.length > 0 && (
        <div className="st-etykiety" role="status" aria-live="polite">
          {etykiety.map((e) => (
            <div key={e.id} className={`st-etykieta ${e.stan}`}>
              <b className="mono">{e.numer}</b>
              <span>{e.tekst}</span>
              <a href={`/zamowienia/${e.id}`} target="_blank" rel="noreferrer">
                Otwórz zamówienie
              </a>
              {e.stan !== 'trwa' && (
                <button type="button" onClick={() => setEtykiety((l) => l.filter((x) => x.id !== e.id))} aria-label={`Zamknij komunikat o etykiecie ${e.numer}`}>
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {wNakladce && !okno && (
        <div className="st-okno" role="dialog" aria-modal="true" aria-labelledby="h-okno">
          <header className="st-okno-head">
            <h1 id="h-okno">
              Pakowanie ({spakowanych}/{sesja.length})
            </h1>
            <button className="st-x" type="button" onClick={zamknijOkno} aria-label="Zamknij okno pakowania (Esc)">
              ✕
            </button>
          </header>
          <div className="st-okno-body">
            <aside className="st-okno-sesja" aria-label="Zamówienia w sesji">
              <div className="st-muted st-small">W sesji: {sesja.length}</div>
              <ListaSesji sesja={sesja} aktywne={null} onOtworz={otworzZSesji} onPodglad={pokazSpakowane} onUsun={usunZSesji} />
            </aside>
            <section className="st-okno-tresc">
              {pasek && (
                <div className={`st-pasek ${pasek.ton}`} role="status" aria-live="polite">
                  {pasek.tekst}
                </div>
              )}
              {nastepneWSesji(sesja, null) ? <p className="st-muted">Wybierz zamówienie z listy.</p> : <Podsumowanie sesja={sesja} onWroc={zamknijOkno} wrocNapis={wrocNapis} />}
            </section>
          </div>
        </div>
      )}
      {!wNakladce && (
      <>
      <header className="st-top">
        <div>
          <b className="st-brand">Kompletor</b> <span className="st-muted">Stanowisko pakowania · {firma}</span>
        </div>
        <div className="st-muted st-who">
          {kto} · <a href="/pulpit">Panel</a>
        </div>
        <StanDrukarek />
      </header>

      <main className="st-scan-wrap">
        <form className="st-scan" onSubmit={wyslijSkan}>
          <label htmlFor="skan" className="st-label">
            Zeskanuj kartę zamówienia albo koszyk
          </label>
          <div className="st-scan-row">
            <input
              id="skan"
              ref={pole}
              className="st-input"
              value={skan}
              onChange={(e) => setSkan(e.target.value)}
              autoFocus
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              inputMode="text"
              placeholder={`np. ${przykladKodu}`}
              aria-describedby="pasek-skanu"
              disabled={okno !== null}
            />
            <button className="btn primary st-btn-skan" type="submit" disabled={zajety || okno !== null}>
              Otwórz
            </button>
          </div>
          <div id="pasek-skanu" className={`st-pasek ${pasek?.ton ?? ''}`} role="status" aria-live="polite">
            {pasek?.tekst ?? 'Czytnik wpisuje kod sam. Pozycje potwierdzasz dotykiem; skan pustego koszyka przy otwartym zamówieniu wkłada je do koszyka, a skan innej karty albo zajętego koszyka przełącza na tamto zamówienie.'}
          </div>
        </form>

        <section className="st-sesja-lista" aria-labelledby="h-sesja">
          <h2 id="h-sesja">
            Zamówienia w sesji <span className="st-licznik">{sesja.length}</span>
          </h2>
          {sesja.length === 0 ? (
            <p className="st-muted">Pusto. Skan karty albo koszyka otwiera zamówienie i dokłada je tutaj.</p>
          ) : (
            <ListaSesji sesja={sesja} aktywne={okno?.z.id ?? null} onOtworz={otworzZSesji} onPodglad={pokazSpakowane} onUsun={usunZSesji} />
          )}
        </section>

        {sesja.length === 0 && (
          <section className="st-nastepne" aria-labelledby="h-nastepne">
            <h2 id="h-nastepne">Następne do spakowania</h2>
            {nastepne.length === 0 ? (
              <p className="st-muted">Kolejka pakowania jest pusta. Nowe zamówienia pojawią się w Pakowaniu same.</p>
            ) : (
              <ul className="st-nastepne-lista">
                {nastepne.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      className="st-nastepne-poz"
                      disabled={zajety || okno !== null}
                      onClick={() => void otworzZSesji({ id: n.id, numer: n.numer, tryb: n.tryb, printId: null, stan: 'czeka', komunikat: null, czerwona: false, pojedynczy: true })}
                    >
                      <span className="mono st-sesja-nr">{n.numer}</span>
                      <Plakietka tryb={n.tryb} />
                      <span className="st-muted">
                        {n.przewoznik} · {n.pozycji} poz.
                      </span>
                      {n.koszyk ? <span className="st-koszyk">Koszyk {n.koszyk}</span> : null}
                      <span className="st-nastepne-akcja">Pakuj</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="st-small st-muted">
              <a href="/pakowanie">Cała kolejka pakowania</a>
            </p>
          </section>
        )}
      </main>
      </>
      )}

      {okno && (
        <div className="st-okno" role="dialog" aria-modal="true" aria-labelledby="h-okno">
          <header className="st-okno-head">
            <h1 id="h-okno">
              Pakowanie ({spakowanych}/{sesja.length}) <span className="st-nr mono">{okno.z.numer}</span> <Plakietka tryb={okno.z.tryb} />
              {okno.z.koszyk ? <span className="st-koszyk">Koszyk {okno.z.koszyk}</span> : null}
              <a className="st-karta-link" href={`/zamowienia/${okno.z.id}`} target="_blank" rel="noreferrer">
                Karta zamówienia ↗
              </a>
            </h1>
            <button ref={naglowekOkna} className="st-x" type="button" onClick={zamknijOkno} aria-label={wNakladce ? "Zamknij okno pakowania" : "Zamknij okno pakowania (Esc)"}>
              ✕
            </button>
          </header>
          <div className="st-okno-body">
            <aside className="st-okno-sesja" aria-label="Zamówienia w sesji">
              <div className="st-muted st-small">W sesji: {sesja.length}</div>
              <ListaSesji sesja={sesja} aktywne={okno.z.id} onOtworz={otworzZSesji} onPodglad={pokazSpakowane} onUsun={usunZSesji} />
            </aside>
            <section className="st-okno-tresc">
              {przejscie && !okno.historia.length && (
                <div className="st-pasek ok st-potw" role="status" aria-live="polite">
                  <span>{przejscie.tekst}</span>
                  <button type="button" className="btn small" onClick={zostanPrzyPoprzednim}>
                    Zostań przy {przejscie.poprzednie.z.numer}
                  </button>
                </div>
              )}
              {okno.pasek && (
                <div className={`st-pasek ${okno.pasek.ton}`} role="status" aria-live="polite">
                  {okno.pasek.tekst}
                </div>
              )}
              {okno.krok === 'podsumowanie' ? (
                <Podsumowanie sesja={sesja} onWroc={zamknijOkno} wrocNapis={wrocNapis} linkDoKolejki={zKolejki} />
              ) : okno.krok === 'zapisane' ? (
                <>
                  <Zapisane
                    tekst={okno.zapisano ?? ''}
                    naSucho={okno.z.tryb === 'CIEN'}
                    odliczanie={odliczanie}
                    onZostan={() => setOdliczanie(null)}
                    onWroc={zamknijOkno}
                    wrocNapis={wrocNapis}
                    onDalej={nastepneWSesji(sesja, okno.z.id) ? () => poZapisieWSesji(sesjaTeraz.current, okno, okno.zapisano ?? '') : undefined}
                  />
                  {/* po „Spakowane” przesyłka z gabarytem z pakowania i druk etykiety na tym stanowisku; konto w cieniu widzi przycisk nieaktywny z powodem */}
                  {/* akcja przesyłki zatrzymuje odliczanie powrotu do skanu, okno nie zamknie się w trakcie */}
                  {okno.spakowane && <NadaniePrzesylki orderId={okno.z.id} gabarytZPakowania={okno.gabaryt ?? null} onStart={() => setOdliczanie(null)} podzialAdresu />}
                  {/* przyciski automatycznych akcji firmy (Ustawienia → Automatyczne akcje) */}
                  {okno.spakowane && <PrzyciskiRegulStanowiska orderId={okno.z.id} onStart={() => setOdliczanie(null)} />}
                </>
              ) : okno.krok === 'gabaryt' ? (
                <WyborGabarytu z={okno.z} zebrane={okno.zebrane} zajety={okno.zajety} onWybierz={(g) => zakoncz('SPAKOWANE', g)} onWroc={() => setOkno({ ...okno, krok: 'pozycje' })} />
              ) : (
                <>
                  <Pozycje okno={okno} setOkno={setOkno} zmien={zmien} wszystko={wszystkoWKoszyku} jednakJest={jednakJest} jednakWPaczce={jednakWPaczce} />
                  {/* 19.11.2026: podgląd spakowanego zamówienia: pod pozycjami przesyłka i ponowny druk etykiety */}
                  {okno.podglad && <NadaniePrzesylki orderId={okno.z.id} gabarytZPakowania={null} podzialAdresu />}
                </>
              )}
            </section>
          </div>
          {okno.krok === 'pozycje' && (
            <Stopka okno={okno} koszykWymagany={ustawienia.koszykWymagany} onWyczysc={() => setOkno({ ...okno, dialog: { etap: 'wyczysc' } })} onCofnij={cofnij} onNie={() => setOkno({ ...okno, dialog: { etap: 'nie_spakowano' } })} onTak={() => setOkno({ ...okno, zebrane: Object.fromEntries(okno.z.pozycje.map((p) => [p.klucz, p.ilosc - (okno.braki[p.klucz]?.ilosc ?? 0)])), krok: 'gabaryt', pasek: null })} />
          )}
          {okno.dialog && <Okienko okno={okno} setOkno={setOkno} onBrak={zapiszBrakPozycji} onNie={() => zakoncz('NIE_SPAKOWANO', null)} onWyczysc={wyczysc} />}
        </div>
      )}
    </div>
  )
}

function ListaSesji({ sesja, aktywne, onOtworz, onPodglad, onUsun }: { sesja: PozycjaSesji[]; aktywne: string | null; onOtworz: (p: PozycjaSesji) => void; onPodglad: (p: PozycjaSesji) => void; onUsun: (id: string) => void }) {
  return (
    <ul className="st-sesja">
      {sesja.map((s) => (
        <li key={s.id} className={`st-sesja-poz ${s.stan} ${s.czerwona ? 'czerwona' : ''} ${aktywne === s.id ? 'aktywne' : ''}`}>
          {s.stan === 'spakowane' ? (
            // 19.11.2026: spakowane zamówienie otwiera się w oknie pakowania jako podgląd (jak w BL), bez komunikatu „już spakowane”
            <button type="button" className="st-sesja-otworz" onClick={() => onPodglad(s)} aria-current={aktywne === s.id ? 'true' : undefined} title="Pokaż spakowane zamówienie">
              <span className="mono st-sesja-nr">{s.numer}</span>
              <Plakietka tryb={s.tryb} />
              <span className="st-sesja-stan">✓ spakowane</span>
            </button>
          ) : (
            <button type="button" className="st-sesja-otworz" onClick={() => onOtworz(s)} aria-current={aktywne === s.id ? 'true' : undefined}>
              <span className="mono st-sesja-nr">{s.numer}</span>
              <Plakietka tryb={s.tryb} />
              <span className="st-sesja-stan">{s.stan === 'nie_spakowano' ? 'nie spakowano' : s.stan === 'blokada' ? (s.czerwona ? 'NIE PAKUJ' : 'uwaga') : 'czeka'}</span>
              {s.komunikat && <span className="st-sesja-kom">{s.komunikat}</span>}
            </button>
          )}
          <button type="button" className="st-sesja-x" onClick={() => onUsun(s.id)} aria-label={`Usuń ${s.numer} z sesji`}>
            ✕
          </button>
        </li>
      ))}
    </ul>
  )
}

function Pozycje({
  okno,
  setOkno,
  zmien,
  wszystko,
  jednakJest,
  jednakWPaczce,
}: {
  okno: Okno
  setOkno: React.Dispatch<React.SetStateAction<Okno | null>>
  zmien: (k: string, n: number) => void
  wszystko: () => void
  jednakJest: (k: string) => void
  jednakWPaczce: (orderLineId: string) => void
}) {
  const z = okno.z
  const maUwagi = Boolean(z.komentarzKlienta || z.uwagiBiura)
  return (
    <>
      <div className="st-info">
        <div className="st-info-wiersz">
          <span className="st-label">Komentarz klienta</span>
          {z.komentarzKlienta ? <p className="st-uwaga">{z.komentarzKlienta}</p> : <span className="st-muted">brak komentarza</span>}
        </div>
        <div className="st-info-wiersz">
          <span className="st-label">Uwagi biura</span>
          {z.uwagiBiura ? <p className="st-uwaga">{z.uwagiBiura}</p> : <span className="st-muted">brak</span>}
        </div>
        {maUwagi && (
          <label className="st-odhacz">
            <input type="checkbox" checked={okno.uwagiOk} onChange={(e) => setOkno((o) => (o ? { ...o, uwagiOk: e.target.checked } : o))} /> Przeczytane i zrobione
          </label>
        )}
        <div className="st-info-wiersz">
          <span className="st-label">Dostawa</span>
          <b>
            {z.przewoznik}
            {z.metodaDostawy ? ` · ${z.metodaDostawy}` : ''}
          </b>
          <span className="st-muted"> · {z.kanal}</span>
        </div>
      </div>
      <div className="st-pozycje-head">
        <h2>Pozycje ({z.pozycje.length})</h2>
        <button type="button" className="btn st-btn-duzy" onClick={wszystko} disabled={okno.zajety}>
          Wszystko w koszyku
        </button>
      </div>
      {z.brakujace.length > 0 && (
        <div className="st-brakujace" role="status">
          <h2>Brakuje, nie pakuj ({z.brakujace.length})</h2>
          <ul>
            {z.brakujace.map((b) => (
              <li key={b.klucz}>
                <b>{ilosc(b.ilosc, b.jednostka)}</b> {b.nazwa}
                {b.dopisek ? <span className="st-muted"> {b.dopisek}</span> : null}
                {z.tryb === 'PRACA' && !okno.braki[b.klucz] && (
                  <button type="button" className="btn small" onClick={() => jednakWPaczce(b.orderLineId)} disabled={okno.zajety}>
                    Jednak jest w paczce
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="st-small">Reszta wychodzi w tej paczce. Brak zostaje u biura: dosłanie albo zwrot.</p>
          {z.tryb === 'PRACA' && (
            <p className="st-small">
              Masz ten towar w ręku? Kliknij „Jednak jest w paczce”: system dołoży go do paczki, jeśli jest na stanie. Gdy powie, że stanu nie ma, towar trzeba najpierw przyjąć w programie magazynowym, a potem w panelu kliknąć Produkty → „Synchronizuj stany” (
              <a href="/produkty" target="_blank" rel="noreferrer">
                otwórz Produkty
              </a>
              ).
            </p>
          )}
        </div>
      )}
      <ul className="st-pozycje">
        {z.pozycje.map((p) => {
          const zeb = okno.zebrane[p.klucz] ?? 0
          const b = okno.braki[p.klucz]
          const max = p.ilosc - (b?.ilosc ?? 0)
          const gotowe = zeb + (b?.ilosc ?? 0) >= p.ilosc
          return (
            <li key={p.klucz} className={`st-poz ${gotowe ? (b ? 'brak' : 'gotowe') : ''}`}>
              <Miniatura zdjecie={p.zdjecie} />
              <div className="st-poz-lok mono">{p.lokalizacja ?? '—'}</div>
              <div className="st-poz-opis">
                <div className="st-poz-nazwa">
                  <b>{p.jednostka === 'g' ? `${p.ilosc} g` : `${p.ilosc} ×`}</b> {p.nazwa}
                </div>
                {p.dopisek && <div className="st-muted st-small">{p.dopisek}</div>}
                {p.sku && <div className="mono st-small st-muted">{p.sku}</div>}
                {b && (
                  <div className="st-poz-brak">
                    Na półce nie było: <b>{ilosc(b.ilosc, p.jednostka)}</b>
                    <button type="button" className="btn small" onClick={() => jednakJest(p.klucz)} disabled={okno.zajety}>
                      Jednak jest
                    </button>
                  </div>
                )}
              </div>
              <div className="st-poz-ster">
                <button type="button" className="st-krok" onClick={() => zmien(p.klucz, zeb - 1)} disabled={zeb <= 0 || okno.zajety} aria-label={`Mniej: ${p.nazwa}`}>
                  −
                </button>
                <span className={`st-ile ${p.ilosc !== 1 || p.jednostka === 'g' ? 'wiele' : ''}`} aria-live="polite">
                  <b>{zeb}</b> z {p.jednostka === 'g' ? `${p.ilosc} g` : p.ilosc}
                </span>
                <button type="button" className="st-krok" onClick={() => zmien(p.klucz, zeb + 1)} disabled={zeb >= max || okno.zajety} aria-label={`Więcej: ${p.nazwa}`}>
                  +
                </button>
                <button type="button" className="st-krok ok" onClick={() => zmien(p.klucz, max)} disabled={zeb >= max || okno.zajety} aria-label={`Wszystko: ${p.nazwa}`}>
                  ✓
                </button>
              </div>
              <div className="st-poz-nie">
                {!gotowe && p.productId && (
                  <button type="button" className="btn st-btn-nie" disabled={okno.zajety} onClick={() => setOkno((o) => (o ? { ...o, dialog: { klucz: p.klucz, etap: 'wybor', ilosc: Math.max(1, max - zeb) } } : o))}>
                    Nie ma w koszyku
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}

function Stopka({ okno, koszykWymagany, onWyczysc, onCofnij, onNie, onTak }: { okno: Okno; koszykWymagany: boolean; onWyczysc: () => void; onCofnij: () => void; onNie: () => void; onTak: () => void }) {
  const z = okno.z
  // 19.11.2026: „Spakowano” nie wymaga odhaczania pozycji; kliknięcie znaczy „wszystko w paczce” poza zgłoszonymi brakami
  const cokolwiek = z.pozycje.some((p) => p.ilosc - (okno.braki[p.klucz]?.ilosc ?? 0) > 0)
  const uwagiBrak = Boolean(z.komentarzKlienta || z.uwagiBiura) && !okno.uwagiOk
  const bezKoszyka = koszykWymagany && !z.koszyk
  const mozna = cokolwiek && !uwagiBrak && !bezKoszyka && !okno.zajety
  const podpowiedz = okno.podglad ? 'Już spakowane' : !cokolwiek ? 'Nic do spakowania' : uwagiBrak ? 'Odhacz uwagi' : bezKoszyka ? 'Zeskanuj koszyk' : 'Wszystko w paczce'
  return (
    <footer className="st-stopka">
      <button type="button" className="btn st-btn-duzy" onClick={onWyczysc} disabled={okno.zajety}>
        Wyczyść
      </button>
      <button type="button" className="btn st-btn-duzy" onClick={onCofnij} disabled={!okno.historia.length || okno.zajety}>
        Cofnij
      </button>
      <button type="button" className="btn danger st-btn-duzy" onClick={onNie} disabled={okno.zajety}>
        Nie spakowano
      </button>
      <button type="button" className="btn primary st-btn-duzy st-btn-tak" onClick={onTak} disabled={!mozna}>
        Spakowano
        <small>{podpowiedz}</small>
      </button>
    </footer>
  )
}

function WyborGabarytu({ z, zebrane, zajety, onWybierz, onWroc }: { z: ZamowienieEkranu; zebrane: Record<string, number>; zajety: boolean; onWybierz: (g: Gabaryt) => void; onWroc: () => void }) {
  const lista = gabarytyDla(z.carrier)
  const { gabaryt: hint, ostrzezenie } = ocenaGabarytu(
    z.carrier,
    z.pozycje.map((p) => ({ ilosc: zebrane[p.klucz] ?? 0, jednostka: p.jednostka, wymiaryCm: p.wymiaryCm ?? null })),
  )
  return (
    <div className="st-gabaryt">
      <h2>Gabaryt paczki — {z.przewoznik}</h2>
      <p className="st-muted">Jedno dotknięcie zapisuje „spakowane{z.tryb === 'CIEN' ? ' próbnie' : ''}”. Podpowiedź z wymiarów produktów, a gdy któryś ich nie ma, z liczby rzeczy w paczce.</p>
      {ostrzezenie && (
        <p className="st-uwaga" role="alert">
          {ostrzezenie}
        </p>
      )}
      <div className="st-gabaryty">
        {lista.map((g) => (
          <button key={g} type="button" className={`st-gab ${g === hint ? 'hint' : ''}`} onClick={() => onWybierz(g)} disabled={zajety}>
            <b>{GABARYTY[g]}</b>
            {g === hint && <small>podpowiedź</small>}
          </button>
        ))}
      </div>
      <button type="button" className="btn st-btn-duzy" onClick={onWroc} disabled={zajety}>
        ← Wróć do pozycji
      </button>
    </div>
  )
}

function Podsumowanie({ sesja, onWroc, wrocNapis, linkDoKolejki = false }: { sesja: PozycjaSesji[]; onWroc: () => void; wrocNapis: string; linkDoKolejki?: boolean }) {
  const p = podsumowanieSesji(sesja)
  return (
    <div className="st-zapisane" role="status">
      <h2>Koniec sesji</h2>
      <p>
        Spakowane: <b>{p.spakowane}</b> · z brakiem: <b>{p.zBrakiem}</b> · pominięte: <b>{p.pominiete}</b>
      </p>
      {sesja.some((s) => s.stan === 'nie_spakowano') && <p className="st-muted st-small">Zamówienie „nie spakowano” otworzysz ponownie z listy zamówień.</p>}
      {sesja.every((s) => s.tryb === 'CIEN') && <p className="st-muted st-small">Pakowanie próbne: zamówienia, rezerwacje i stan bez zmian.</p>}
      <div className="st-zapisane-akcje">
        {linkDoKolejki && (
          <a className="btn primary st-btn-duzy" href="/pakowanie">
            Wróć do kolejki
          </a>
        )}
        <button type="button" className={`btn st-btn-duzy ${linkDoKolejki ? '' : 'primary'}`} onClick={onWroc}>
          {wrocNapis}
        </button>
      </div>
    </div>
  )
}

function Zapisane({ tekst, naSucho, odliczanie, onZostan, onWroc, wrocNapis, onDalej }: { tekst: string; naSucho: boolean; odliczanie: number | null; onZostan: () => void; onWroc: () => void; wrocNapis: string; onDalej?: () => void }) {
  return (
    <div className="st-zapisane" role="status">
      <h2>Zapisane ✓</h2>
      <p>{tekst}</p>
      {naSucho && <p className="st-muted st-small">Pakowanie próbne: zamówienie, rezerwacje i stan bez zmian.</p>}
      <div className="st-zapisane-akcje">
        {odliczanie !== null && (
          <button type="button" className="btn st-btn-duzy" onClick={onZostan}>
            Zostań tutaj ({odliczanie})
          </button>
        )}
        {onDalej && (
          <button type="button" className="btn primary st-btn-duzy" onClick={onDalej}>
            Następne zamówienie
          </button>
        )}
        <button type="button" className={`btn st-btn-duzy ${onDalej ? '' : 'primary'}`} onClick={onWroc}>
          {wrocNapis}
        </button>
      </div>
    </div>
  )
}

function Okienko({
  okno,
  setOkno,
  onBrak,
  onNie,
  onWyczysc,
}: {
  okno: Okno
  setOkno: React.Dispatch<React.SetStateAction<Okno | null>>
  onBrak: (klucz: string, ile: number) => void
  onNie: () => void
  onWyczysc: () => void
}) {
  const d = okno.dialog!
  const zamknij = () => setOkno((o) => (o ? { ...o, dialog: null } : o))
  if (d.etap === 'nie_spakowano' || d.etap === 'wyczysc') {
    return (
      <div className="st-modal" role="alertdialog" aria-modal="true" aria-labelledby="h-dlg">
        <div className="st-modal-box">
          <h2 id="h-dlg">{d.etap === 'nie_spakowano' ? `${okno.z.numer}: nie spakowano?` : 'Wyczyścić zebrane?'}</h2>
          <p className="st-muted">
            {d.etap === 'nie_spakowano'
              ? okno.z.tryb === 'PRACA' ? 'Koszyk wraca, zamówienie czeka. Zgłoszony brak zostaje w zamówieniu.' : 'Zapis „Nie spakowano” w ćwiczeniu. „Na półce nie było” zostaje na liście „Do poprawy w wFirmie”.'
              : 'Zebrane wracają do zera, „na półce nie było” z tego zamówienia znika z listy „Do poprawy”.'}
          </p>
          <div className="st-modal-akcje">
            <button type="button" className="btn st-btn-duzy" onClick={zamknij} autoFocus>
              Wróć
            </button>
            <button type="button" className="btn danger st-btn-duzy" onClick={d.etap === 'nie_spakowano' ? onNie : onWyczysc} disabled={okno.zajety}>
              {d.etap === 'nie_spakowano' ? 'Nie spakowano' : 'Wyczyść'}
            </button>
          </div>
        </div>
      </div>
    )
  }
  const p = okno.z.pozycje.find((x) => x.klucz === d.klucz)
  if (!p) return null
  const max = p.ilosc - (okno.zebrane[p.klucz] ?? 0)
  return (
    <div className="st-modal" role="alertdialog" aria-modal="true" aria-labelledby="h-dlg">
      <div className="st-modal-box">
        <h2 id="h-dlg">Nie ma w koszyku: {p.nazwa}</h2>
        {d.etap === 'wybor' ? (
          <div className="st-modal-akcje pion">
            <button type="button" className="btn st-btn-duzy" onClick={zamknij} autoFocus>
              Doniosę z półki
            </button>
            <button type="button" className="btn danger st-btn-duzy" onClick={() => setOkno((o) => (o ? { ...o, dialog: { ...d, etap: 'ilosc' } } : o))}>
              Na półce nie było
            </button>
          </div>
        ) : (
          <>
            <p className="st-muted">{okno.z.tryb === 'PRACA' ? 'Ile nie było na półce? Brak zapisze się w zamówieniu i zdejmie rezerwację; biuro zdecyduje, co dalej.' : 'Ile nie było na półce? Pozycja trafi od razu na listę „Do poprawy w wFirmie”. Rezerwacji i stanu ćwiczenie nie zmienia.'}</p>
            <div className="st-poz-ster st-modal-ile">
              <button type="button" className="st-krok" onClick={() => setOkno((o) => (o ? { ...o, dialog: { ...d, ilosc: Math.max(1, d.ilosc - 1) } } : o))} disabled={d.ilosc <= 1} aria-label="Mniej">
                −
              </button>
              <span className="st-ile wiele">
                <b>{d.ilosc}</b> z {p.jednostka === 'g' ? `${max} g` : max}
              </span>
              <button type="button" className="st-krok" onClick={() => setOkno((o) => (o ? { ...o, dialog: { ...d, ilosc: Math.min(max, d.ilosc + 1) } } : o))} disabled={d.ilosc >= max} aria-label="Więcej">
                +
              </button>
            </div>
            <div className="st-modal-akcje">
              <button type="button" className="btn st-btn-duzy" onClick={zamknij} autoFocus>
                Jednak jest
              </button>
              <button type="button" className="btn danger st-btn-duzy" onClick={() => onBrak(p.klucz, d.ilosc)} disabled={okno.zajety || max < 1}>
                Na półce nie było: {ilosc(d.ilosc, p.jednostka)}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
