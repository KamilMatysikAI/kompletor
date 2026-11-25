'use client'
// „Zamów kuriera” przy pasku przewoźnika w kolejce pakowania: okno z datą, godzinami odbioru, liczbą paczek i wagą
// (domyślnie z harmonogramu odbiorów i paczek czekających na kuriera). Widoczne tylko u przewoźnika z włączonym
// „Zamawianie kuriera z Kompletora” w koncie. Drugie zamówienie tego samego dnia: osobny przycisk z ostrzeżeniem.
// Godziny: zawsze dwa pola; wolne przedziały przewoźnika (odczyt dostępności przy otwarciu okna) to podpowiedź, która
// po kliknięciu wpisuje godziny i nigdy nie blokuje zamówienia (lista przewoźnika nie jest zamknięta). Domyślne godziny
// z tej samej reguły co automat (lib/wysylka/kurier-regula.ts). Pod paskiem jedna linia na dzień odbioru
// (lib/wysylka/kurier-widok.ts), wcześniejsze próby zwinięte, a przy niewiadomej dwa przyciski rozstrzygnięcia.
// Przewoźnik po przesyłkach (Wysyłam z Allegro, `poPrzesylkach`): bez liczby paczek i wagi (zamówienie obejmuje
// przesyłki z numerem nadania); terminy przewoźnika to te same podpowiedzi przy polach godzin co przedziały DPD.
import { useActionState, useRef, useState } from 'react'
import { Baner, Modal, PoleLiczbowe, PoleTekstowe, Przycisk, ToastPoAkcji } from '@/app/ui'
import { etykietaOdbioru, godzinyPoOdczycie, hm, kluczPrzedzialu, liniePaskaKuriera, opisZlecenia, przesylekSlowo, scalOdbioryPaska, podpowiedziNaDzien, powodPoLudzku, trybOknaKuriera, UWAGA_BEZ_LISTY, type DostepnoscOkna, type ZlecenieKuriera } from '@/lib/wysylka/kurier-widok'
import { wybierzPrzedzial, type RegulaPrzedzialu } from '@/lib/wysylka/kurier-regula'
import { przedzialyKurieraAkcja, rozstrzygnijKurieraAkcja, zamowKurieraAkcja, type StanKuriera } from './akcje'

const START: StanKuriera = { komunikat: null }

export interface DomyslneKuriera {
  data: string
  od: string
  do: string
  liczba: number
  waga: number
}


/** Kontekst domyślnych godzin: reguła przedziałów przewoźnika (ta sama co w automacie), dziś i godzina odbioru. */
export interface KontekstKuriera {
  regula: RegulaPrzedzialu
  dzis: string
  terazMin: number
  godzinaOdbioruMin: number | null
}

export function ZamowKuriera({ carrier, label, powod, domyslne, zlecenia, zamowione = [], kontekst, poPrzesylkach = false }: { carrier: string; label: string; powod: string | null; domyslne: DomyslneKuriera; /** zlecenia przewoźnika od dziś: tryb okna (zwykłe / ponów / drugi raz) liczony dla dnia w oknie (`trybOknaKuriera`) */ zlecenia: readonly ZlecenieKuriera[]; /** podjazdy już zamówione od dziś (dzień + opis): informacja w oknie przy wyborze innego dnia */ zamowione?: readonly { dzien: string; opis: string }[]; kontekst: KontekstKuriera; /** zamówienie obejmuje przesyłki z numerem nadania (`domyslne.liczba`), bez liczby i wagi w oknie */ poPrzesylkach?: boolean }) {
  const [otwarty, setOtwarty] = useState(false)
  // „Zamów drugi raz” obok „Ponów nieudany odbiór”: świadomy wybór osoby, okno ostrzega przed drugim podjazdem
  const [chceDrugi, setChceDrugi] = useState(false)
  // wynik częściowy (część odbiorów przyjęta): zostaje przy pasku do zamknięcia ręcznego, nie znika jak toast
  const [czesciowy, setCzesciowy] = useState<string | null>(null)
  const [data, setData] = useState(domyslne.data)
  const [od, setOd] = useState(domyslne.od)
  const [doG, setDoG] = useState(domyslne.do)
  // godziny wpisane albo wybrane przez osobę nie są nadpisywane domyślnymi z odczytu przedziałów
  // (ref, nie stan: odczyt przedziałów wraca po kilku sekundach i decyzja o godzinach bierze wartość z chwili powrotu)
  const reczneRef = useRef(false)
  const dataRef = useRef(domyslne.data)
  const odczytRef = useRef(0)
  const setReczne = (v: boolean) => {
    reczneRef.current = v
  }
  const ustawDate = (d: string) => {
    dataRef.current = d
    setData(d)
  }
  const [dost, setDost] = useState<DostepnoscOkna | null>(null)
  const [laduje, setLaduje] = useState(false)
  const [stan, action, pending] = useActionState(async (p: StanKuriera, f: FormData) => {
    const w = await zamowKurieraAkcja(p, f)
    if (w.ok) setOtwarty(false)
    setCzesciowy(w.ok && w.ton === 'info' ? (w.komunikat ?? null) : null)
    return w
  }, START)
  /** Domyślne godziny dla dnia z przedziałów przewoźnika (podpowiedzi) wg reguły; null = bez zmiany. */
  const domyslneGodziny = (d: DostepnoscOkna | null, dzien: string) => {
    const lista = podpowiedziNaDzien(d, dzien, kontekst.dzis, kontekst.terazMin).podpowiedzi
    return wybierzPrzedzial({ kandydaci: lista, regula: kontekst.regula, dzisiaj: dzien === kontekst.dzis, terazMin: kontekst.terazMin, godzinaOdbioruMin: kontekst.godzinaOdbioruMin })
  }
  const ustaw = (p: { odMin: number; doMin: number }) => {
    setOd(hm(p.odMin))
    setDoG(hm(p.doMin))
  }
  const pobierz = async () => {
    const nr = ++odczytRef.current
    setLaduje(true)
    let d: DostepnoscOkna
    try {
      d = await przedzialyKurieraAkcja(carrier)
    } catch {
      d = { tryb: 'POLA', uwaga: UWAGA_BEZ_LISTY }
    } finally {
      if (nr === odczytRef.current) setLaduje(false)
    }
    if (nr !== odczytRef.current) return
    setDost(d)
    const p = godzinyPoOdczycie(d, { reczne: reczneRef.current, data: dataRef.current, aktualny: nr === odczytRef.current }, domyslneGodziny)
    if (p) ustaw(p)
  }
  const otworz = (drugiRaz: boolean) => {
    setChceDrugi(drugiRaz)
    setOtwarty(true)
    ustawDate(domyslne.data)
    setOd(domyslne.od)
    setDoG(domyslne.do)
    setReczne(false)
    void pobierz()
  }
  const zmienDzien = (d: string) => {
    ustawDate(d)
    if (!reczneRef.current) {
      const p = domyslneGodziny(dost, d)
      if (p) ustaw(p)
    }
    // po nieudanym odczycie próbujemy jeszcze raz
    if (!laduje && dost?.tryb === 'POLA' && dost.uwaga === UWAGA_BEZ_LISTY) void pobierz()
  }
  const naDzien = podpowiedziNaDzien(dost, data, kontekst.dzis, kontekst.terazMin)
  const wybrany = `${od}-${doG}`
  const ileP = (n: number) => `${n} ${przesylekSlowo(n)}`
  // tryb przycisku przy pasku: dzień domyślny; tryb okna: dzień wybrany w oknie (po zmianie dnia okno mówi, co zamówi)
  const naPasku = trybOknaKuriera(zlecenia, kontekst.dzis, domyslne.data)
  const tryb = trybOknaKuriera(zlecenia, kontekst.dzis, data, chceDrugi)
  const drugi = tryb.tryb === 'DRUGI'
  const ponow = tryb.tryb === 'PONOW' ? tryb : null
  const zamowiony = tryb.tryb === 'DRUGI' ? opisZlecenia(tryb.zamowiony, etykietaOdbioru(label, tryb.zamowiony.grupa), kontekst.dzis) : null
  const tytul = drugi ? `Zamówić drugi raz kuriera ${label}?` : ponow ? `Ponów nieudany odbiór ${label}` : `Zamów kuriera ${label}`
  return (
    <>
      {/* wynik częściowy: baner przy pasku zamiast toastu (toast znika po kilku sekundach) */}
      <ToastPoAkcji stan={stan.ton === 'info' ? null : stan} />
      {czesciowy && (
        <Baner
          ton="info"
          rola="status"
          tytul="Wynik zamówienia kuriera:"
          akcja={
            <Przycisk type="button" rozmiar="sm" wariant="cichy" onClick={() => setCzesciowy(null)}>
              Zamknij
            </Przycisk>
          }
        >
          {czesciowy}
        </Baner>
      )}
      {naPasku.tryb === 'PONOW' ? (
        <>
          <Przycisk wariant="drugorzedny" powodWylaczenia={powod} onClick={() => otworz(false)}>
            Ponów nieudany odbiór ({ileP(naPasku.przesylek)})
          </Przycisk>
          <Przycisk wariant="cichy" rozmiar="sm" powodWylaczenia={powod} onClick={() => otworz(true)}>
            Zamów drugi raz
          </Przycisk>
        </>
      ) : (
        <Przycisk wariant={naPasku.tryb === 'DRUGI' ? 'cichy' : 'drugorzedny'} rozmiar={naPasku.tryb === 'DRUGI' ? 'sm' : undefined} powodWylaczenia={powod} onClick={() => otworz(false)}>
          {naPasku.tryb === 'DRUGI' ? 'Zamów drugi raz' : `Zamów kuriera ${label}`}
        </Przycisk>
      )}
      <Modal otwarty={otwarty} onZamknij={() => setOtwarty(false)} tytul={tytul}>
        <form action={action} className="kurier-okno" aria-label={tytul}>
          <input type="hidden" name="przewoznik" value={carrier} />
          {drugi && <input type="hidden" name="drugi" value="tak" />}
          {ponow && (
            <Baner ton="info">
              Nie udał się odbiór: {ponow.nazwy} ({ileP(ponow.przesylek)}). Kompletor zamówi tylko ten odbiór; zamówione już odbiory zostają bez zmian.
            </Baner>
          )}
          {tryb.tryb === 'DRUGI' && (
            <Baner ton="ostrzezenie">
              {tryb.nieudany
                ? `${zamowiony}. Drugie zamówienie obejmie nieudany odbiór (${tryb.nieudany.nazwy}, ${ileP(tryb.nieudany.przesylek)}) i przesyłki nadane po ostatnim zamówieniu; przyjęte odbiory zostają bez zmian. Każdy nowy odbiór to osobny podjazd kuriera (u przewoźnika może kosztować). Jeśli chcesz ponowić tylko nieudany odbiór, zamknij okno i kliknij „Ponów nieudany odbiór”.`
                : `${zamowiony}. Drugie zamówienie to drugi podjazd kuriera (u przewoźnika może kosztować). Zamawiaj tylko, gdy pierwszy kurier nie przyjedzie albo nie zabierze wszystkich paczek.`}
            </Baner>
          )}
          {zamowione
            .filter((z) => z.dzien !== data && !(drugi && z.opis === zamowiony))
            .map((z) => (
              <Baner key={`${z.dzien}-${z.opis}`} ton="info">
                Podjazd jest już zamówiony: {z.opis}. Zamówienie na inny dzień to osobny podjazd.
              </Baner>
            ))}
          <PoleTekstowe id={`k-data-${carrier}`} name="data" type="date" etykieta="Dzień odbioru" value={data} onChange={(e) => zmienDzien(e.target.value)} required data-fokus />
          <div className="kurier-godziny">
            <PoleTekstowe id={`k-od-${carrier}`} name="od" type="time" etykieta="Od godziny" value={od} onChange={(e) => (setOd(e.target.value), setReczne(true))} required step={900} />
            <PoleTekstowe id={`k-do-${carrier}`} name="do" type="time" etykieta="Do godziny" value={doG} onChange={(e) => (setDoG(e.target.value), setReczne(true))} required step={900} />
          </div>
          {laduje && !dost && <p className="muted small">Sprawdzam wolne godziny podjazdu u przewoźnika…</p>}
          {naDzien.podpowiedzi.length > 0 && (
            <div className="kurier-podpowiedzi" role="group" aria-label="Przedziały, które podał przewoźnik">
              <span className="muted small">Przedziały przewoźnika (kliknij, żeby wpisać):</span>
              {naDzien.podpowiedzi.map((p) => (
                <Przycisk
                  key={kluczPrzedzialu(p)}
                  type="button"
                  rozmiar="sm"
                  wariant={kluczPrzedzialu(p) === wybrany ? 'drugorzedny' : 'cichy'}
                  aria-pressed={kluczPrzedzialu(p) === wybrany}
                  onClick={() => (ustaw(p), setReczne(true))}
                >
                  {hm(p.odMin)}–{hm(p.doMin)}
                  {p.dopisek ? ` (${p.dopisek})` : ''}
                </Przycisk>
              ))}
            </div>
          )}
          {naDzien.uwaga && <p className="muted small">{naDzien.uwaga}</p>}
          {naDzien.podpowiedzi.length > 0 && <p className="muted small">Możesz wpisać też inne godziny: przewoźnik przyjmie albo odrzuci je przy zamówieniu.</p>}
          {poPrzesylkach ? (
            !ponow && (
              <p className="small">
                Na liście {ileP(domyslne.liczba).endsWith('przesyłki') ? 'czekają' : 'czeka'} {ileP(domyslne.liczba)} z numerem nadania. Zamówienie obejmie te, które odbiera kurier {label}; paczki innych przewoźników zostają poza zamówieniem.
              </p>
            )
          ) : (
            <div className="kurier-godziny">
              <PoleLiczbowe id={`k-liczba-${carrier}`} name="liczba" etykieta="Liczba paczek" defaultValue={domyslne.liczba || 1} min={1} max={500} required />
              <PoleLiczbowe id={`k-waga-${carrier}`} name="waga" etykieta="Waga łączna" jednostka="kg" defaultValue={domyslne.waga || ''} min={0.01} step={0.01} required />
            </div>
          )}
          {!ponow && <p className="muted small">Numer zlecenia pojawi się przy pasku kuriera.</p>}
          <div className="ui-modal-stopka">
            <Przycisk type="button" wariant="cichy" onClick={() => setOtwarty(false)}>
              Anuluj
            </Przycisk>
            <Przycisk type="submit" wariant={drugi ? 'niebezpieczny' : 'glowny'} ladowanie={pending}>
              {drugi ? 'Tak, zamów drugi raz' : ponow ? 'Ponów nieudany odbiór' : 'Zamów kuriera'}
            </Przycisk>
          </div>
        </form>
      </Modal>
    </>
  )
}

/** „DPD przyjął zlecenie” / „DPD nie przyjął” przy zamówieniu, o którym nie wiadomo, czy dotarło; każdy z potwierdzeniem. */
function Rozstrzygnij({ z, label }: { z: ZlecenieKuriera; label: string }) {
  const [okno, setOkno] = useState<'PRZYJAL' | 'NIE_PRZYJAL' | null>(null)
  const [stan, action, pending] = useActionState(async (p: StanKuriera, f: FormData) => {
    const w = await rozstrzygnijKurieraAkcja(p, f)
    if (w.ok) setOkno(null)
    return w
  }, START)
  const tytul = okno === 'PRZYJAL' ? `${label} przyjął zlecenie?` : `${label} nie przyjął zlecenia?`
  return (
    <>
      <ToastPoAkcji stan={stan} />
      <Przycisk rozmiar="sm" onClick={() => setOkno('PRZYJAL')}>
        {label} przyjął zlecenie
      </Przycisk>
      <Przycisk rozmiar="sm" wariant="cichy" onClick={() => setOkno('NIE_PRZYJAL')}>
        {label} nie przyjął
      </Przycisk>
      <Modal otwarty={okno !== null} onZamknij={() => setOkno(null)} tytul={tytul}>
        <form action={action} className="kurier-okno" aria-label={tytul}>
          <input type="hidden" name="zlecenie" value={z.id} />
          <input type="hidden" name="wariant" value={okno ?? ''} />
          {okno === 'PRZYJAL' ? (
            <>
              <p>Zaznacz tylko wtedy, gdy w panelu {label} albo telefonicznie potwierdzisz, że kurier jest zamówiony. Zamówienie zostanie zapisane jako przyjęte i drugie kliknięcie „Zamów kuriera” go nie powtórzy.</p>
              <PoleTekstowe id={`k-numer-${z.id}`} name="numer" etykieta="Numer zlecenia" pomoc="Z panelu przewoźnika albo od konsultanta; możesz zostawić puste." opcjonalne maxLength={40} data-fokus />
            </>
          ) : (
            <p>Zaznacz, gdy w panelu {label} albo telefonicznie sprawdzisz, że zlecenia nie ma. Potem możesz zamówić kuriera na ten dzień jeszcze raz. Jeśli {label} jednak przyjął to zlecenie, kolejne zamówienie na ten dzień oznacza drugi, płatny podjazd.</p>
          )}
          <div className="ui-modal-stopka">
            <Przycisk type="button" wariant="cichy" onClick={() => setOkno(null)} data-fokus={okno === 'NIE_PRZYJAL' ? '' : undefined}>
              Anuluj
            </Przycisk>
            <Przycisk type="submit" wariant="glowny" ladowanie={pending}>
              {okno === 'PRZYJAL' ? 'Tak, przyjął' : 'Tak, nie przyjął'}
            </Przycisk>
          </div>
        </form>
      </Modal>
    </>
  )
}

/** Jedno zlecenie: opis, „szczegóły” z technicznym powodem przewoźnika i przyciski rozstrzygnięcia przy niewiadomej. */
function Zlecenie({ z, label, dzis, podjazd = false }: { z: ZlecenieKuriera; label: string; dzis: string; /** tego dnia jest przyjęty odbiór (rada „zapytaj kuriera przy podjeździe”) */ podjazd?: boolean }) {
  const p = z.stan === 'BLAD' || z.stan === 'NIEJEDNOZNACZNY' ? powodPoLudzku(z.powod) : null
  const szczegoly = z.recznie ? z.powod : p?.szczegoly ?? (z.stan === 'NIEJEDNOZNACZNY' ? z.powod : null)
  return (
    <div className="kurier-zlecenie">
      <span className={z.stan === 'ZAMOWIONY' ? 'chip leaf' : 'chip amber'}>{opisZlecenia(z, label, dzis, { podjazd })}</span>
      {szczegoly && (
        <details className="kurier-szczegoly">
          <summary>szczegóły</summary>
          <span className="muted small">{szczegoly}</span>
        </details>
      )}
      {z.stan === 'NIEJEDNOZNACZNY' && <Rozstrzygnij z={z} label={label} />}
    </div>
  )
}

/** Linie pod paskiem kuriera: jedna na dzień odbioru (dziś, potem przyszłe), wcześniejsze próby zwinięte. */
export function LinieKuriera({ zlecenia, label, dzis }: { zlecenia: readonly ZlecenieKuriera[]; label: string; dzis: string }) {
  const linie = scalOdbioryPaska(liniePaskaKuriera(zlecenia, dzis))
  const zPodjazdem = new Set(linie.filter((l) => l.glowna.stan === 'ZAMOWIONY').map((l) => l.dzien))
  return (
    <>
      {linie.map((l) => (
        <div key={`${l.dzien}|${l.grupa ?? ''}|${l.glowna.id}`} className="kurier-linia">
          <Zlecenie z={l.glowna} label={etykietaOdbioru(label, l.grupa)} dzis={dzis} podjazd={zPodjazdem.has(l.dzien)} />
          {l.pozostale.length > 0 && (
            <details className="kurier-proby">
              <summary>
                {l.wczesniejsze ? 'wcześniejsze próby' : 'inne próby tego dnia'}: {l.pozostale.length}
              </summary>
              {l.pozostale.map((z) => (
                <Zlecenie key={z.id} z={z} label={etykietaOdbioru(label, z.grupa)} dzis={dzis} podjazd={zPodjazdem.has(z.dzien)} />
              ))}
            </details>
          )}
        </div>
      ))}
    </>
  )
}
