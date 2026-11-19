'use client'
// Ustawienia → Automatyczne akcje. Tabela reguł w grupach (zwijane),
// „kiedy” jako szare pigułki warunków, „co robi” jako zielone ponumerowane kroki, przełącznik, podgląd na sucho,
// duplikuj, usuń; kolejność przeciąganiem albo strzałkami (klawiatura, telefon). Okno edycji: Kiedy → Jeśli → Zrób,
// jeden zapis na okno. Zakładka „Grupy akcji”: nazwy, kolejność, zwinięcie na start, usunięcie (reguły do „Bez grupy”).
import { useEffect, useMemo, useState, useTransition } from 'react'
import { Modal, Potwierdzenie, Przycisk, PrzyciskLink, PustyStan, useToast } from '@/app/ui'
import type { EkranAutomatow, RegulaEkranu } from '@/lib/automaty/dane'
import { KROKI, MIEJSCA_PRZYCISKU, PRZEWOZNICY_WARUNKU, SZABLONY_MAILI, WARUNKI, ZDARZENIA, type TypKroku, type TypWarunku, type Zdarzenie } from '@/lib/automaty/schemat'
import type { BladReguly } from '@/lib/automaty/schemat'
import { CARRIER_LABEL } from '@/lib/panel/format'
import { duplikujAkcja, grupaAkcja, kolejnoscAkcja, kolejnoscGrupAkcja, planWbudowanyAkcja, maileZwrotowAkcja, podgladAkcja, przelaczAkcja, usunAkcja, usunGrupeAkcja, zapiszReguleAkcja, type WynikAkcji } from './akcje'

/** widok zwarty (jedna linia na regułę, jak lista w BaseLinkerze); wybór zapamiętany w przeglądarce. */
const KLUCZ_ZWARTY = 'kompletor.automaty.zwarty'
/** Od tylu reguł lista startuje w widoku zwartym, dopóki osoba sama nie wybierze. */
const ZWARTY_OD = 20

type Ekran = EkranAutomatow
type Uklad = { groupId: string | null; ids: string[] }[]

/**
 * wbudowany plan maili do zamówień (Brak płatności, Faktura, Błąd faktury, Gotowe do odbioru). Włączony:
 * planuje je Kompletor, a krok „Wyślij e-mail” reguły nie dubluje maila. Wyłączony: te maile planują tylko reguły.
 */
function PlanWbudowany({ wlaczony, trwa, onZmien }: { wlaczony: boolean; trwa: boolean; onZmien: (v: boolean) => void }) {
  return (
    <div className="aut-plan" role="group" aria-labelledby="aut-plan-t">
      <label className="aut-check">
        <input type="checkbox" role="switch" checked={wlaczony} disabled={trwa} onChange={(e) => onZmien(e.target.checked)} />
        <span id="aut-plan-t">Maile do zamówień planuje też Kompletor (Brak płatności, Faktura, Błąd faktury, Gotowe do odbioru)</span>
      </label>
      <p className="aut-objasnienie">
        {wlaczony
          ? 'Włączone: te maile wychodzą także bez reguł, a krok „Wyślij e-mail” w regule pomija mail, który Kompletor już zaplanował. Wyłącz, gdy maile mają iść tylko z Twoich reguł.'
          : 'Wyłączone: te maile wychodzą tylko z reguł z krokiem „Wyślij e-mail”. Bez takiej reguły klient ich nie dostanie.'}
      </p>
    </div>
  )
}

/** Maile do klienta o zwrotach i reklamacjach (Zwrot dotarł, Reklamacja dotarła, Pieniądze zwrócone); domyślnie wyłączone. */
function MaileZwrotow({ wlaczony, trwa, onZmien }: { wlaczony: boolean; trwa: boolean; onZmien: (v: boolean) => void }) {
  return (
    <div className="aut-plan" role="group" aria-labelledby="aut-zwroty-t">
      <label className="aut-check">
        <input type="checkbox" role="switch" checked={wlaczony} disabled={trwa} onChange={(e) => onZmien(e.target.checked)} />
        <span id="aut-zwroty-t">Maile do klienta o zwrotach i reklamacjach (Zwrot dotarł, Reklamacja dotarła, Pieniądze zwrócone)</span>
      </label>
      <p className="aut-objasnienie">
        {wlaczony
          ? 'Włączone: klient dostaje mail, gdy paczka ze zwrotem albo reklamacją dotrze do magazynu oraz gdy przy zwrocie zapisany jest zwrot pieniędzy. Dotyczy zwrotów odebranych od chwili włączenia; wcześniejsze nie dostają maila. Zwrot odrzucony nie dostaje maila. Na koncie w trybie „Tylko podgląd” mail się tylko zapisuje, nie wychodzi. Treść zmienisz w Poczcie, w szablonach.'
          : 'Wyłączone: klient nie dostaje maili o zwrotach i reklamacjach z Kompletora. Po włączeniu maile dotyczą tylko zwrotów odebranych od tej chwili.'}
      </p>
    </div>
  )
}

function uklad(e: Ekran): Uklad {
  const out: Uklad = [{ groupId: null, ids: e.reguly.filter((r) => !r.groupId).map((r) => r.id) }]
  for (const g of e.grupy) out.push({ groupId: g.id, ids: e.reguly.filter((r) => r.groupId === g.id).map((r) => r.id) })
  return out
}

export function ListaAutomatow({ ekran: start, widok }: { ekran: Ekran; widok: 'reguly' | 'grupy' }) {
  const [ekran, setEkran] = useState(start)
  const [trwa, startTransition] = useTransition()
  const toast = useToast()
  const [edycja, setEdycja] = useState<{ regula: RegulaEkranu | null; groupId: string | null } | null>(null)
  const [doUsuniecia, setDoUsuniecia] = useState<RegulaEkranu | null>(null)
  const [zwiniete, setZwiniete] = useState<Set<string>>(() => new Set(start.grupy.filter((g) => g.collapsed).map((g) => g.id)))
  const [podglad, setPodglad] = useState<{ nazwa: string; zdanie: string } | null>(null)
  const [ciagniety, setCiagniety] = useState<string | null>(null)
  const [zwarty, setZwarty] = useState(start.reguly.length >= ZWARTY_OD)
  useEffect(() => {
    const v = window.localStorage.getItem(KLUCZ_ZWARTY)
    if (v === '1' || v === '0') setZwarty(v === '1')
  }, [])
  const zmienZwarty = (v: boolean) => {
    setZwarty(v)
    window.localStorage.setItem(KLUCZ_ZWARTY, v ? '1' : '0')
  }

  const poAkcji = (w: WynikAkcji) => {
    if (w.ekran) setEkran(w.ekran)
    if (w.ok) toast.sukces(w.komunikat)
    else toast.blad(w.komunikat)
    for (const o of w.ostrzezenia ?? []) toast.info(o.komunikat)
  }
  const akcja = (fn: () => Promise<WynikAkcji>) => startTransition(async () => poAkcji(await fn()))
  const byId = useMemo(() => new Map(ekran.reguly.map((r) => [r.id, r])), [ekran])
  const sekcje = useMemo(() => uklad(ekran), [ekran])

  const przenies = (id: string, cel: { groupId: string | null; index: number }) => {
    const nowy = sekcje.map((s) => ({ ...s, ids: s.ids.filter((x) => x !== id) }))
    const s = nowy.find((x) => x.groupId === cel.groupId)
    if (!s) return
    s.ids.splice(Math.max(0, Math.min(cel.index, s.ids.length)), 0, id)
    akcja(() => kolejnoscAkcja(nowy))
  }
  const strzalka = (id: string, o: -1 | 1) => {
    const s = sekcje.find((x) => x.ids.includes(id))!
    const i = s.ids.indexOf(id)
    if (i + o < 0 || i + o >= s.ids.length) return
    przenies(id, { groupId: s.groupId, index: i + o })
  }

  if (widok === 'grupy') return <Grupy ekran={ekran} akcja={akcja} trwa={trwa} />

  const nazwaGrupy = (g: string | null) => (g ? (ekran.grupy.find((x) => x.id === g)?.name ?? '') : 'Bez grupy')
  const pusto = !ekran.reguly.length

  return (
    <div className={zwarty ? 'aut zwarty' : 'aut'}>
      <div className="aut-pasek">
        <p className="aut-objasnienie">Reguły wykonują się od góry: najpierw „Bez grupy”, potem grupy w kolejności. Przy dwóch regułach ustawiających status zostaje status z reguły niżej.</p>
        <div className="aut-pasek-akcje">
          {!pusto && (
            <label className="aut-check">
              <input type="checkbox" checked={zwarty} onChange={(e) => zmienZwarty(e.target.checked)} />
              Widok zwarty
            </label>
          )}
          <Przycisk wariant="glowny" onClick={() => setEdycja({ regula: null, groupId: null })}>
            Dodaj automatyczną akcję
          </Przycisk>
        </div>
      </div>
      <PlanWbudowany wlaczony={ekran.planWbudowany} trwa={trwa} onZmien={(v) => akcja(() => planWbudowanyAkcja(v))} />
      <MaileZwrotow wlaczony={ekran.maileZwrotow} trwa={trwa} onZmien={(v) => akcja(() => maileZwrotowAkcja(v))} />
      {pusto && (
        <PustyStan
          tytul="Nie masz jeszcze automatycznych akcji"
          akcja={
            <>
              <PrzyciskLink href="/ustawienia/automaty/szablony" wariant="glowny">
                Wczytaj szablon
              </PrzyciskLink>
              <Przycisk wariant="drugorzedny" onClick={() => setEdycja({ regula: null, groupId: null })}>
                Dodaj pierwszą regułę
              </Przycisk>
            </>
          }
        >
          Najprościej zacząć od gotowego szablonu (kurier i paczkomaty, odbiór osobisty, Allegro, bez wysyłki) i dopasować go do siebie. Możesz też ułożyć reguły od zera, na przykład: opłacone zamówienie z odbiorem w sklepie dostaje status „Do odbioru w sklepie”.
        </PustyStan>
      )}
      {!pusto &&
        sekcje.map((s) => {
          const klucz = s.groupId ?? '_bez'
          const zw = zwiniete.has(klucz)
          if (!s.groupId && !s.ids.length && ekran.grupy.length) return null
          return (
            <section
              key={klucz}
              className="aut-grupa"
              aria-label={nazwaGrupy(s.groupId)}
              onDragOver={(e) => ciagniety && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                if (ciagniety) przenies(ciagniety, { groupId: s.groupId, index: s.ids.length })
                setCiagniety(null)
              }}
            >
              <header className="aut-grupa-nagl">
                <button
                  type="button"
                  className="aut-zwin"
                  aria-expanded={!zw}
                  onClick={() =>
                    setZwiniete((z) => {
                      const n = new Set(z)
                      if (n.has(klucz)) n.delete(klucz)
                      else n.add(klucz)
                      return n
                    })
                  }
                >
                  <span aria-hidden="true" className={zw ? 'aut-chev zw' : 'aut-chev'}>
                    ⌃
                  </span>
                  <h2>{nazwaGrupy(s.groupId)}</h2>
                  <span className="aut-ile">{s.ids.length === 1 ? '1 reguła' : `${s.ids.length} ${s.ids.length % 10 >= 2 && s.ids.length % 10 <= 4 && (s.ids.length % 100 < 10 || s.ids.length % 100 >= 20) ? 'reguły' : 'reguł'}`}</span>
                </button>
                <Przycisk wariant="cichy" rozmiar="sm" onClick={() => setEdycja({ regula: null, groupId: s.groupId })}>
                  Dodaj tutaj
                </Przycisk>
              </header>
              {!zw && (
                <ol className="aut-lista" role="list">
                  {s.ids.length === 0 && <li className="aut-pusta-grupa">Przeciągnij tu regułę albo dodaj nową.</li>}
                  {s.ids.map((id, i) => {
                    const r = byId.get(id)!
                    return (
                      <li
                        key={id}
                        className={`aut-wiersz${r.enabled ? '' : ' wyl'}${ciagniety === id ? ' ciag' : ''}`}
                        draggable
                        onDragStart={(e) => {
                          setCiagniety(id)
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragEnd={() => setCiagniety(null)}
                        onDragOver={(e) => ciagniety && e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          if (ciagniety && ciagniety !== id) przenies(ciagniety, { groupId: s.groupId, index: i })
                          setCiagniety(null)
                        }}
                      >
                        <div className="aut-uchwyt">
                          <span className="aut-kropki" aria-hidden="true" title="Przeciągnij, żeby zmienić kolejność">
                            ⠿
                          </span>
                          <button type="button" className="aut-strz" aria-label={`Przesuń „${r.name}” wyżej`} disabled={i === 0 || trwa} onClick={() => strzalka(id, -1)}>
                            ▲
                          </button>
                          <button type="button" className="aut-strz" aria-label={`Przesuń „${r.name}” niżej`} disabled={i === s.ids.length - 1 || trwa} onClick={() => strzalka(id, 1)}>
                            ▼
                          </button>
                        </div>
                        <div className="aut-kiedy">
                          <button type="button" className="aut-nazwa" title={zwarty ? (r.description ? `${r.name}. ${r.description}` : r.name) : undefined} onClick={() => setEdycja({ regula: r, groupId: r.groupId })}>
                            {r.event === 'PRZYCISK' ? `Przycisk „${r.buttonLabel || r.name}”` : r.zdarzenie}
                          </button>
                          {r.event !== 'PRZYCISK' && r.name !== r.zdarzenie && <span className="aut-podpis">{r.name}</span>}
                          {!r.enabled && <span className="aut-wyl-zwarty">Wyłączona</span>}
                          {r.description && <span className="aut-opis">{r.description}</span>}
                          {r.pigulki.length > 0 && (
                            <ul className="aut-pigulki" role="list" aria-label="Warunki">
                              {r.pigulki.map((p, j) => (
                                <li key={j} className="aut-pig">
                                  <span className="aut-pig-e">{p.etykieta}</span>
                                  <span className="aut-pig-w">
                                    {p.nie && <span className="aut-nie">nie: </span>}
                                    {p.wartosc}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <ol className="aut-kroki" aria-label="Wykonywane akcje">
                          {r.kroki.map((k, j) => (
                            <li key={j}>
                              <span className="aut-nr">{j + 1}.</span>
                              <span className="aut-czas">{k.czasownik}</span>
                              <span className="aut-krok">
                                <span className="aut-krok-co">{k.co}</span>
                                {k.wartosc && <span className="aut-krok-w">{k.wartosc}</span>}
                              </span>
                            </li>
                          ))}
                        </ol>
                        <div className="aut-akcje">
                          <label className="toggle aut-toggle" title={r.enabled ? 'Wyłącz regułę' : 'Włącz regułę'}>
                            <input type="checkbox" role="switch" checked={r.enabled} disabled={trwa} aria-label={`${r.enabled ? 'Wyłącz' : 'Włącz'} regułę „${r.name}”`} onChange={(e) => akcja(() => przelaczAkcja(id, e.target.checked))} />
                          </label>
                          <Przycisk
                            wariant="cichy"
                            rozmiar="sm"
                            disabled={trwa}
                            onClick={() =>
                              startTransition(async () => {
                                const w = await podgladAkcja({ name: r.name, event: r.event, conditions: r.conditions, actions: r.actions, buttonLabel: r.buttonLabel, buttonPlaces: r.buttonPlaces })
                                setPodglad({ nazwa: r.name, zdanie: w.zdanie })
                              })
                            }
                          >
                            Sprawdź
                          </Przycisk>
                          <Przycisk wariant="cichy" rozmiar="sm" disabled={trwa} onClick={() => akcja(() => duplikujAkcja(id))}>
                            Duplikuj
                          </Przycisk>
                          <Przycisk wariant="cichy" rozmiar="sm" disabled={trwa} onClick={() => setDoUsuniecia(r)}>
                            Usuń
                          </Przycisk>
                        </div>
                        {r.ostrzezenia.length > 0 && (
                          <div className="aut-ostrz" role="note">
                            {r.ostrzezenia.map((o, j) => (
                              <p key={j}>
                                <span aria-hidden="true">⚠ </span>
                                {o.komunikat}
                              </p>
                            ))}
                          </div>
                        )}
                        <p className="aut-licznik">{r.wykonan7 ? `W ostatnich 7 dniach: ${r.wykonan7}` : r.enabled ? 'W ostatnich 7 dniach: nie zadziałała' : 'Wyłączona'}</p>
                      </li>
                    )
                  })}
                </ol>
              )}
            </section>
          )
        })}
      {edycja && (
        <OknoReguly
          ekran={ekran}
          regula={edycja.regula}
          groupId={edycja.groupId}
          onZamknij={() => setEdycja(null)}
          onZapisano={(w) => {
            poAkcji(w)
            if (w.ok) setEdycja(null)
          }}
        />
      )}
      <Potwierdzenie
        otwarte={!!doUsuniecia}
        tytul="Usunąć regułę?"
        tak="Usuń"
        wariant="niebezpieczny"
        onNie={() => setDoUsuniecia(null)}
        onTak={() => {
          const id = doUsuniecia!.id
          setDoUsuniecia(null)
          akcja(() => usunAkcja(id))
        }}
      >
        <p>„{doUsuniecia?.name}”. Reguła, która już coś zrobiła albo pochodzi z ustawień startowych firmy, zostanie wyłączona i ukryta, a jej wpisy zostaną w historii zamówień.</p>
      </Potwierdzenie>
      <Modal otwarty={!!podglad} onZamknij={() => setPodglad(null)} tytul={`Sprawdzenie: ${podglad?.nazwa ?? ''}`} stopka={<Przycisk onClick={() => setPodglad(null)}>Zamknij</Przycisk>}>
        <p>{podglad?.zdanie}</p>
      </Modal>
    </div>
  )
}

// ─── Okno edycji ─────────────────────────────────────────────────────────────

type W = Record<string, unknown> & { typ: TypWarunku }
type K = Record<string, unknown> & { typ: TypKroku }

const NOWY_WARUNEK: Record<TypWarunku, W> = {
  zrodlo: { typ: 'zrodlo', wartosci: [], nie: false },
  pobranie: { typ: 'pobranie', wartosc: false },
  oplacone: { typ: 'oplacone', wartosc: true },
  przesylka: { typ: 'przesylka', frazy: [], nie: false },
  przewoznik: { typ: 'przewoznik', wartosci: [], nie: false },
  status: { typ: 'status', wartosci: [], nie: false },
  kwota: { typ: 'kwota', od: null, do: null },
  dniWStatusie: { typ: 'dniWStatusie', dni: 2, robocze: true },
  statusPrzesylki: { typ: 'statusPrzesylki', frazy: [], nie: false },
}

function OknoReguly({ ekran, regula, groupId: g0, onZamknij, onZapisano }: { ekran: Ekran; regula: RegulaEkranu | null; groupId: string | null; onZamknij: () => void; onZapisano: (w: WynikAkcji) => void }) {
  const [name, setName] = useState(regula?.name ?? '')
  const [event, setEvent] = useState<Zdarzenie>(regula?.event ?? 'OPLACONO')
  const [groupId, setGroupId] = useState<string | null>(regula?.groupId ?? g0)
  const [warunki, setWarunki] = useState<W[]>(() => (regula?.conditions ?? []).map((w) => ({ ...w }) as W))
  const [kroki, setKroki] = useState<K[]>(() => (regula?.actions ?? [{ typ: 'ustawStatus', status: ekran.statusy[0]?.key ?? '' }]).map((k) => ({ ...k }) as K))
  const [buttonLabel, setButtonLabel] = useState(regula?.buttonLabel ?? '')
  const [miejsca, setMiejsca] = useState<string[]>(regula?.buttonPlaces?.length ? regula.buttonPlaces : ['karta'])
  const [opis, setOpis] = useState(regula?.description ?? '')
  const [bledy, setBledy] = useState<BladReguly[]>([])
  const [wynik, setWynik] = useState<string | null>(null)
  const [trwa, startTransition] = useTransition()
  const dane = () => ({ name: name || (event === 'PRZYCISK' ? buttonLabel : ZDARZENIA[event].nazwa), event, conditions: warunki, actions: kroki, buttonLabel, buttonPlaces: miejsca, description: opis })
  const blad = (pole: string) => bledy.find((b) => b.pole === pole)?.komunikat
  const zapisz = (enabled?: boolean) =>
    startTransition(async () => {
      const w = await zapiszReguleAkcja({ id: regula?.id ?? null, groupId, enabled, regula: dane() })
      setBledy(w.bledy ?? [])
      onZapisano(w)
    })
  const ustawW = (i: number, p: Partial<W>) => setWarunki((l) => l.map((x, j) => (j === i ? ({ ...x, ...p } as W) : x)))
  const ustawK = (i: number, p: Partial<K>) => setKroki((l) => l.map((x, j) => (j === i ? ({ ...x, ...p } as K) : x)))
  const lista = (v: unknown) => (Array.isArray(v) ? (v as string[]) : [])
  const przelacz = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])

  return (
    <Modal
      otwarty
      szeroki
      onZamknij={onZamknij}
      tytul={regula ? `Edycja: ${regula.name}` : 'Nowa automatyczna akcja'}
      stopka={
        <>
          <Przycisk onClick={onZamknij}>Anuluj</Przycisk>
          <Przycisk ladowanie={trwa} onClick={() => zapisz()}>
            Zapisz
          </Przycisk>
          {!regula?.enabled && (
            <Przycisk wariant="glowny" ladowanie={trwa} onClick={() => zapisz(true)}>
              Zapisz i włącz
            </Przycisk>
          )}
        </>
      }
    >
      <div className="aut-okno">
        {bledy.length > 0 && (
          <div className="aut-bledy" role="alert">
            {bledy.map((b, i) => (
              <p key={i}>{b.komunikat}</p>
            ))}
          </div>
        )}
        <fieldset className="aut-sekcja">
          <legend>1. Kiedy</legend>
          <label className="aut-pole">
            <span>Zdarzenie</span>
            <select value={event} onChange={(e) => setEvent(e.target.value as Zdarzenie)}>
              {(Object.keys(ZDARZENIA) as Zdarzenie[]).map((z) => (
                <option key={z} value={z}>
                  {ZDARZENIA[z].nazwa}
                </option>
              ))}
            </select>
            <small>{ZDARZENIA[event].opis}</small>
          </label>
          {event === 'PRZYCISK' && (
            <>
              <label className="aut-pole">
                <span>Napis na przycisku</span>
                <input value={buttonLabel} maxLength={40} onChange={(e) => setButtonLabel(e.target.value)} placeholder="np. Paczka mała" />
              </label>
              <fieldset className="aut-pole">
                <legend>Gdzie widać przycisk</legend>
                {Object.entries(MIEJSCA_PRZYCISKU).map(([k, v]) => (
                  <label key={k} className="aut-check">
                    <input type="checkbox" checked={miejsca.includes(k)} onChange={() => setMiejsca((m) => przelacz(m, k))} /> {v}
                  </label>
                ))}
              </fieldset>
            </>
          )}
          <div className="aut-dwa">
            <label className="aut-pole">
              <span>Nazwa reguły</span>
              <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="np. Odbiór w sklepie" />
              {blad('nazwa') && <small className="ui-blad">{blad('nazwa')}</small>}
            </label>
            <label className="aut-pole">
              <span>Grupa</span>
              <select value={groupId ?? ''} onChange={(e) => setGroupId(e.target.value || null)}>
                <option value="">Bez grupy</option>
                {ekran.grupy.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="aut-pole">
            <span>Opis dla zespołu (opcjonalnie)</span>
            <textarea value={opis} maxLength={300} rows={2} onChange={(e) => setOpis(e.target.value)} placeholder="np. Wyłączona: fakturę wystawiamy po spakowaniu" />
            {blad('opis') && <small className="ui-blad">{blad('opis')}</small>}
          </label>
        </fieldset>

        <fieldset className="aut-sekcja">
          <legend>2. Jeśli (wszystkie warunki naraz)</legend>
          {!warunki.length && <p className="aut-pomoc">Bez warunków reguła działa dla każdego zamówienia przy tym zdarzeniu.</p>}
          {warunki.map((w, i) => (
            <div key={i} className="aut-wiersz-ed">
              <div className="aut-wiersz-ed-g">
                <strong>{WARUNKI[w.typ].nazwa}</strong>
                {WARUNKI[w.typ].negacja && (
                  <label className="aut-check">
                    <input type="checkbox" checked={w.nie === true} onChange={(e) => ustawW(i, { nie: e.target.checked })} /> nie
                  </label>
                )}
                <Przycisk wariant="cichy" rozmiar="sm" onClick={() => setWarunki((l) => l.filter((_, j) => j !== i))} aria-label={`Usuń warunek ${WARUNKI[w.typ].nazwa}`}>
                  Usuń
                </Przycisk>
              </div>
              {w.typ === 'zrodlo' && (
                <div className="aut-opcje">
                  {ekran.konta.map((k) => (
                    <label key={k.wartosc} className="aut-check">
                      <input type="checkbox" checked={lista(w.wartosci).includes(k.wartosc)} onChange={() => ustawW(i, { wartosci: przelacz(lista(w.wartosci), k.wartosc) })} /> {k.nazwa}
                    </label>
                  ))}
                  {!ekran.konta.length && <p className="aut-pomoc">Firma nie ma jeszcze kont sprzedaży.</p>}
                </div>
              )}
              {(w.typ === 'pobranie' || w.typ === 'oplacone') && (
                <select value={w.wartosc ? 'tak' : 'nie'} onChange={(e) => ustawW(i, { wartosc: e.target.value === 'tak' })} aria-label={WARUNKI[w.typ].nazwa}>
                  <option value="tak">Tak</option>
                  <option value="nie">Nie</option>
                </select>
              )}
              {(w.typ === 'przesylka' || w.typ === 'statusPrzesylki') && (
                <input aria-label="Frazy po przecinku" value={lista(w.frazy).join(', ')} placeholder="np. Paczkomaty, DPD" onChange={(e) => ustawW(i, { frazy: e.target.value.split(',').map((x) => x.trimStart()) })} />
              )}
              {w.typ === 'przewoznik' && (
                <div className="aut-opcje">
                  {PRZEWOZNICY_WARUNKU.map((c) => (
                    <label key={c} className="aut-check">
                      <input type="checkbox" checked={lista(w.wartosci).includes(c)} onChange={() => ustawW(i, { wartosci: przelacz(lista(w.wartosci), c) })} /> {CARRIER_LABEL[c] ?? c}
                    </label>
                  ))}
                </div>
              )}
              {w.typ === 'status' && (
                <div className="aut-opcje">
                  {ekran.statusy.map((s) => (
                    <label key={s.key} className="aut-check">
                      <input type="checkbox" checked={lista(w.wartosci).includes(s.key)} onChange={() => ustawW(i, { wartosci: przelacz(lista(w.wartosci), s.key) })} /> {s.name}
                    </label>
                  ))}
                </div>
              )}
              {w.typ === 'kwota' && (
                <div className="aut-dwa">
                  <label className="aut-pole">
                    <span>Od (zł)</span>
                    <input inputMode="decimal" value={(w.od as string | number | null) ?? ''} onChange={(e) => ustawW(i, { od: e.target.value === '' ? null : e.target.value })} />
                  </label>
                  <label className="aut-pole">
                    <span>Do (zł)</span>
                    <input inputMode="decimal" value={(w.do as string | number | null) ?? ''} onChange={(e) => ustawW(i, { do: e.target.value === '' ? null : e.target.value })} />
                  </label>
                </div>
              )}
              {w.typ === 'dniWStatusie' && (
                <div className="aut-dwa">
                  <label className="aut-pole">
                    <span>Liczba dni</span>
                    <input type="number" min={1} max={365} value={Number(w.dni) || 1} onChange={(e) => ustawW(i, { dni: Number(e.target.value) })} />
                  </label>
                  <label className="aut-check">
                    <input type="checkbox" checked={w.robocze !== false} onChange={(e) => ustawW(i, { robocze: e.target.checked })} /> tylko dni robocze
                  </label>
                </div>
              )}
              {blad(`warunek-${i}`) && <small className="ui-blad">{blad(`warunek-${i}`)}</small>}
            </div>
          ))}
          <label className="aut-pole aut-dodaj">
            <span>Dodaj warunek</span>
            <select
              value=""
              onChange={(e) => {
                const t = e.target.value as TypWarunku
                if (t) setWarunki((l) => [...l, { ...NOWY_WARUNEK[t] }])
              }}
            >
              <option value="">Wybierz…</option>
              {(Object.keys(WARUNKI) as TypWarunku[])
                .filter((t) => (t === 'dniWStatusie' ? event === 'W_STATUSIE_DNI' : t === 'statusPrzesylki' ? event === 'STATUS_PRZESYLKI' : true))
                .map((t) => (
                  <option key={t} value={t}>
                    {WARUNKI[t].nazwa}
                  </option>
                ))}
            </select>
          </label>
          {blad('warunki') && <small className="ui-blad">{blad('warunki')}</small>}
        </fieldset>

        <fieldset className="aut-sekcja">
          <legend>3. Zrób (po kolei)</legend>
          {kroki.map((k, i) => (
            <div key={i} className="aut-wiersz-ed">
              <div className="aut-wiersz-ed-g">
                <strong>
                  {i + 1}. {KROKI[k.typ].nazwa}
                </strong>
                <button type="button" className="aut-strz" aria-label="Krok wyżej" disabled={i === 0} onClick={() => setKroki((l) => zamien(l, i, i - 1))}>
                  ▲
                </button>
                <button type="button" className="aut-strz" aria-label="Krok niżej" disabled={i === kroki.length - 1} onClick={() => setKroki((l) => zamien(l, i, i + 1))}>
                  ▼
                </button>
                <Przycisk wariant="cichy" rozmiar="sm" onClick={() => setKroki((l) => l.filter((_, j) => j !== i))} aria-label={`Usuń krok ${i + 1}`}>
                  Usuń
                </Przycisk>
              </div>
              <small className="aut-pomoc">{KROKI[k.typ].opis}</small>
              {k.typ === 'ustawStatus' && (
                <select aria-label="Status" value={String(k.status ?? '')} onChange={(e) => ustawK(i, { status: e.target.value })}>
                  {ekran.statusy.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
              {k.typ === 'wyslijEmail' && (
                <select aria-label="Szablon maila" value={String(k.szablon ?? '')} onChange={(e) => ustawK(i, { szablon: e.target.value })}>
                  {Object.entries(SZABLONY_MAILI).map(([s, v]) => (
                    <option key={s} value={s}>
                      {v.nazwa}
                    </option>
                  ))}
                </select>
              )}
              {k.typ === 'wyslijEmail' && (
                <small className="aut-pomoc">
                  {k.szablon === 'blad-faktury'
                    ? 'Dla zwykłych błędów faktury mail do biura wysyła już Kompletor. Ten krok wysyła go tylko przy chwilowym limicie programu do faktur (błąd „LIMIT:”), przy innych błędach zostanie pominięty.'
                    : 'Te same maile wysyła też wbudowany plan maili Kompletora. Ten sam mail wychodzi do klienta raz, bez względu na to, czy pierwszy zaplanowała go reguła, czy plan.'}
                </small>
              )}
              {k.typ === 'utworzPrzesylke' && (
                <label className="aut-pole">
                  <span>Gabaryt (opcjonalnie)</span>
                  <select value={String(k.gabaryt ?? '')} onChange={(e) => ustawK(i, { gabaryt: e.target.value || null })}>
                    <option value="">jak w ustawieniach przewoźnika</option>
                    {['A', 'B', 'C'].map((g) => (
                      <option key={g} value={g}>
                        Gabaryt {g}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {k.typ === 'drukujEtykiete' && (
                <label className="aut-pole">
                  <span>Stanowisko druku</span>
                  <select value={String(k.stanowisko ?? '')} onChange={(e) => ustawK(i, { stanowisko: e.target.value || null })}>
                    <option value="">pierwsze aktywne</option>
                    {ekran.stanowiska.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.nazwa}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {k.typ === 'oznacz' && (
                <label className="aut-check">
                  <input type="checkbox" checked={k.wartosc !== false} onChange={(e) => ustawK(i, { znacznik: 'gwiazdka', wartosc: e.target.checked })} /> gwiazdka na liście zamówień
                </label>
              )}
              {blad(`krok-${i}`) && <small className="ui-blad">{blad(`krok-${i}`)}</small>}
            </div>
          ))}
          <label className="aut-pole aut-dodaj">
            <span>Dodaj krok</span>
            <select
              value=""
              onChange={(e) => {
                const t = e.target.value as TypKroku
                if (!t) return
                const nowy: K = t === 'ustawStatus' ? { typ: t, status: ekran.statusy[0]?.key ?? '' } : t === 'wyslijEmail' ? { typ: t, szablon: 'faktura' } : t === 'oznacz' ? { typ: t, znacznik: 'gwiazdka', wartosc: true } : { typ: t }
                setKroki((l) => [...l, nowy])
              }}
            >
              <option value="">Wybierz…</option>
              {(Object.keys(KROKI) as TypKroku[]).map((t) => (
                <option key={t} value={t}>
                  {KROKI[t].nazwa}
                </option>
              ))}
            </select>
          </label>
          {blad('kroki') && <small className="ui-blad">{blad('kroki')}</small>}
        </fieldset>

        <div className="aut-sprawdz">
          <Przycisk
            ladowanie={trwa}
            onClick={() =>
              startTransition(async () => {
                const w = await podgladAkcja(dane())
                setBledy(w.bledy ?? [])
                setWynik(w.zdanie)
              })
            }
          >
            Sprawdź na ostatnich 7 dniach
          </Przycisk>
          {wynik && (
            <p className="aut-wynik" role="status">
              {wynik}
            </p>
          )}
        </div>
      </div>
    </Modal>
  )
}

function zamien<T>(l: T[], a: number, b: number): T[] {
  const n = [...l]
  ;[n[a], n[b]] = [n[b]!, n[a]!]
  return n
}

// ─── Grupy ───────────────────────────────────────────────────────────────────

function Grupy({ ekran, akcja, trwa }: { ekran: Ekran; akcja: (fn: () => Promise<WynikAkcji>) => void; trwa: boolean }) {
  const [nowa, setNowa] = useState('')
  const [nazwy, setNazwy] = useState<Record<string, string>>({})
  const [doUsuniecia, setDoUsuniecia] = useState<string | null>(null)
  const ids = ekran.grupy.map((g) => g.id)
  const ile = (id: string) => ekran.reguly.filter((r) => r.groupId === id).length
  return (
    <div className="aut">
      <form
        className="aut-pasek"
        onSubmit={(e) => {
          e.preventDefault()
          if (!nowa.trim()) return
          akcja(() => grupaAkcja({ name: nowa }))
          setNowa('')
        }}
      >
        <label className="aut-pole aut-nowa-grupa">
          <span>Nowa grupa</span>
          <input value={nowa} maxLength={40} onChange={(e) => setNowa(e.target.value)} placeholder="np. Zbieranie i pakowanie" />
        </label>
        <Przycisk type="submit" wariant="glowny" disabled={trwa}>
          Dodaj grupę
        </Przycisk>
      </form>
      {!ekran.grupy.length && <PustyStan tytul="Nie ma jeszcze grup">Grupy porządkują długą listę reguł (np. „Przyjęcie zamówień”, „Zbieranie i pakowanie”, „Przyciski”). Reguły bez grupy wykonują się jako pierwsze.</PustyStan>}
      <ol className="aut-lista aut-grupy" role="list">
        {ekran.grupy.map((g, i) => (
          <li key={g.id} className="aut-wiersz aut-wiersz-grupy">
            <div className="aut-uchwyt">
              <button type="button" className="aut-strz" aria-label={`Grupa „${g.name}” wyżej`} disabled={i === 0 || trwa} onClick={() => akcja(() => kolejnoscGrupAkcja(zamien(ids, i, i - 1)))}>
                ▲
              </button>
              <button type="button" className="aut-strz" aria-label={`Grupa „${g.name}” niżej`} disabled={i === ids.length - 1 || trwa} onClick={() => akcja(() => kolejnoscGrupAkcja(zamien(ids, i, i + 1)))}>
                ▼
              </button>
            </div>
            <label className="aut-pole">
              <span className="sr-only">Nazwa grupy</span>
              <input value={nazwy[g.id] ?? g.name} maxLength={40} onChange={(e) => setNazwy((n) => ({ ...n, [g.id]: e.target.value }))} onBlur={() => nazwy[g.id] !== undefined && nazwy[g.id] !== g.name && akcja(() => grupaAkcja({ id: g.id, name: nazwy[g.id] }))} />
            </label>
            <span className="aut-ile">{ile(g.id)} w grupie</span>
            <label className="aut-check">
              <input type="checkbox" checked={g.collapsed} disabled={trwa} onChange={(e) => akcja(() => grupaAkcja({ id: g.id, name: nazwy[g.id] ?? g.name, collapsed: e.target.checked }))} /> zwinięta na start
            </label>
            <Przycisk wariant="cichy" rozmiar="sm" disabled={trwa} onClick={() => setDoUsuniecia(g.id)}>
              Usuń
            </Przycisk>
          </li>
        ))}
      </ol>
      <Potwierdzenie
        otwarte={!!doUsuniecia}
        tytul="Usunąć grupę?"
        tak="Usuń grupę"
        wariant="niebezpieczny"
        onNie={() => setDoUsuniecia(null)}
        onTak={() => {
          const id = doUsuniecia!
          setDoUsuniecia(null)
          akcja(() => usunGrupeAkcja(id))
        }}
      >
        <p>Reguły z tej grupy nie znikną: przejdą na koniec „Bez grupy”.</p>
      </Potwierdzenie>
    </div>
  )
}
