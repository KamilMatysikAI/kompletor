'use client'
// Kafel kanału na ekranie „Publikacja”: podgląd gotowej oferty (tytuł, kategoria, parametry z brakami na
// czerwono, opis, zdjęcia, cena, stan), lista „Do poprawy” i „Wystaw” — widoczny zawsze, nieaktywny z powodem.
// Podgląd liczy akcja serwera po wejściu na ekran (odczyt kanału tylko GET); „Odśwież podgląd” liczy od nowa.
// 3b-2b: ręczny wybór kategorii z propozycji Allegro i wartości brakujących parametrów. Wybór żyje na tym ekranie
// (nie zapisuje się przy produkcie); „Wystaw” wysyła ofertę z tym samym wyborem, który widać w podglądzie.
import { useCallback, useEffect, useState, useTransition } from 'react'
import { Karta, Ladowanie, ListaOpisowa, Odznaka, Przycisk, PrzyciskPotwierdz, useToast, Wybor } from '@/app/ui'
import { type KafelPublikacji, opcjeKategorii, parametryDoUzupelnienia, WARTOSC_PARAMETRU_MAX, type WyborReczny, wyborPusty } from '@/lib/oferty/publikacja'
import { przygotujPodgladPublikacji, wystawOferte } from './akcje'

export function KafelKanalu({ productId, klucz, nazwaKanalu, nazwaKonta, mozeWystawiac }: { productId: string; klucz: string; nazwaKanalu: string; nazwaKonta: string | null; mozeWystawiac: boolean }) {
  const [kafel, setKafel] = useState<KafelPublikacji | null>(null)
  const [blad, setBlad] = useState<string | null>(null)
  const [laduje, startLadowania] = useTransition()
  const [wystawia, startWystawiania] = useTransition()
  const [wybor, setWybor] = useState<WyborReczny>({ kategoriaId: null, parametry: {} })
  const toast = useToast()

  const wczytaj = useCallback(
    (w: WyborReczny) => {
      startLadowania(async () => {
        const r = await przygotujPodgladPublikacji(productId, klucz, w)
        if (r.ok) {
          setKafel(r.kafel)
          setBlad(null)
        } else setBlad(r.blad)
      })
    },
    [productId, klucz],
  )

  useEffect(() => {
    wczytaj(wybor)
  }, [wczytaj, wybor])

  const wystaw = () =>
    startWystawiania(async () => {
      const w = await wystawOferte(productId, klucz, wybor)
      if (w.ok) toast.sukces(w.komunikat)
      else toast.blad(w.komunikat)
      wczytaj(wybor)
    })

  const zastosujParametry = (fd: FormData) => {
    const parametry: Record<string, string> = {}
    for (const [k, v] of fd.entries()) if (k.startsWith('param:') && typeof v === 'string' && v.trim()) parametry[k.slice(6)] = v.trim()
    setWybor((w) => ({ ...w, parametry }))
  }

  const tytul = nazwaKonta ? `${nazwaKanalu}: ${nazwaKonta}` : nazwaKanalu
  const odswiez = (
    <Przycisk rozmiar="sm" onClick={() => wczytaj(wybor)} ladowanie={laduje}>
      Odśwież podgląd
    </Przycisk>
  )
  if (!kafel)
    return (
      <Karta tytul={tytul} naglowekPoziom={2} akcje={blad ? odswiez : undefined} className="pub-kafel">
        {blad ? <p className="small">{blad}</p> : <Ladowanie>Przygotowuję podgląd oferty…</Ladowanie>}
      </Karta>
    )

  const bledy = kafel.problemy.filter((p) => p.waga === 'blad')
  const ostrzezenia = kafel.problemy.filter((p) => p.waga === 'ostrzezenie')
  const powod = !mozeWystawiac ? 'Nie masz uprawnienia do wystawiania ofert' : kafel.wystaw.powody[0]
  const kategorie = opcjeKategorii(kafel)
  const doUzupelnienia = parametryDoUzupelnienia(kafel)
  const idPola = (s: string) => `pub-${klucz.replace(/[^A-Za-z0-9_-]/g, '-')}-${s}`
  return (
    <Karta
      tytul={tytul}
      naglowekPoziom={2}
      opis={kafel.rodzaj}
      akcje={odswiez}
      className="pub-kafel"
      stopka={
        <div className="pub-wystaw">
          <form action={wystaw}>
            <PrzyciskPotwierdz
              wariant="glowny"
              tytul={`Wystawić: ${kafel.nazwaKanalu}?`}
              pytanie={`${kafel.rodzaj}. Tytuł: „${kafel.tytul}”. Oferta powstanie w kanale od razu po potwierdzeniu.`}
              tak="Wystaw"
              powodWylaczenia={powod}
              ladowanie={wystawia}
            >
              Wystaw
            </PrzyciskPotwierdz>
          </form>
          {!kafel.wystaw.mozna && (
            <ul className="small pub-powody" aria-label="Dlaczego „Wystaw” jest nieaktywny">
              {kafel.wystaw.powody.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      }
    >
      <div className="chips">
        {bledy.length ? <Odznaka ton="blad">Do poprawy: {bledy.length}</Odznaka> : <Odznaka ton="sukces">Oferta gotowa</Odznaka>}
        {ostrzezenia.length > 0 && <Odznaka ton="ostrzezenie">Uwagi: {ostrzezenia.length}</Odznaka>}
        {kafel.bezPolaczenia && <Odznaka ton="neutralny">Podgląd z danych produktu</Odznaka>}
      </div>
      {kafel.problemy.length > 0 && (
        <>
          <h3 className="small">Do poprawy</h3>
          <ul className="small pub-problemy">
            {kafel.problemy.map((p, i) => (
              <li key={i} className={p.waga === 'blad' ? 'pub-blad' : undefined}>
                {p.waga === 'blad' ? 'Błąd: ' : 'Uwaga: '}
                {p.komunikat}
              </li>
            ))}
          </ul>
        </>
      )}
      <ListaOpisowa
        pozycje={[
          { klucz: 'tytul', etykieta: 'Tytuł', wartosc: kafel.tytul || <span className="pub-blad">brak</span> },
          { klucz: 'kategoria', etykieta: 'Kategoria', wartosc: kafel.kategoria ?? <span className="pub-blad">nie wybrana</span> },
          { klucz: 'cena', etykieta: 'Cena', wartosc: kafel.cena ?? <span className="pub-blad">brak ceny</span> },
          { klucz: 'stan', etykieta: 'Stan', wartosc: `${kafel.stan} szt.` },
        ]}
      />
      {kategorie.length > 0 && (
        <Wybor
          id={idPola('kategoria')}
          etykieta="Zmień kategorię"
          pomoc="Allegro proponuje te kategorie dla nazwy produktu. Po zmianie podgląd przelicza parametry. Wybór działa na tym ekranie i nie zapisuje się przy produkcie."
          opcje={kategorie}
          value={wybor.kategoriaId ?? ''}
          disabled={laduje}
          onChange={(e) => setWybor((w) => ({ ...w, kategoriaId: e.target.value || null }))}
        />
      )}
      {doUzupelnienia.length > 0 && (
        <form action={zastosujParametry} className="pub-reczne">
          <h3 className="small">Uzupełnij parametry</h3>
          <p className="muted small">Wpisz wartości, których Kompletor nie znalazł na karcie produktu. Podpowiedzi pochodzą ze słownika Allegro. Na stałe uzupełnisz je w cechach produktu albo w mapie kategorii firmy.</p>
          {doUzupelnienia.map((p) => (
            <div key={p.id} className="field ui-pole">
              <label htmlFor={idPola(`param-${p.id}`)}>
                {p.nazwa}
                {p.wymagany && <span className="muted"> (wymagany)</span>}
              </label>
              <input
                id={idPola(`param-${p.id}`)}
                name={`param:${p.id}`}
                className="input"
                defaultValue={wybor.parametry[p.id] ?? ''}
                maxLength={WARTOSC_PARAMETRU_MAX}
                list={p.przyklady.length ? idPola(`lista-${p.id}`) : undefined}
                placeholder={p.przyklady[0] ? `np. ${p.przyklady[0]}` : undefined}
              />
              {p.przyklady.length > 0 && (
                <datalist id={idPola(`lista-${p.id}`)}>
                  {p.przyklady.map((x) => (
                    <option key={x} value={x} />
                  ))}
                </datalist>
              )}
            </div>
          ))}
          <div className="actions">
            <Przycisk type="submit" rozmiar="sm" ladowanie={laduje}>
              Zastosuj w podglądzie
            </Przycisk>
            {!wyborPusty(wybor) && (
              <Przycisk type="button" rozmiar="sm" wariant="cichy" onClick={() => setWybor({ kategoriaId: null, parametry: {} })} disabled={laduje}>
                Wyczyść ręczny wybór
              </Przycisk>
            )}
          </div>
        </form>
      )}
      {kafel.parametry.length > 0 && (
        <>
          <h3 className="small">Parametry</h3>
          <table className="tbl cards small">
            <thead>
              <tr>
                <th scope="col">Parametr</th>
                <th scope="col">Wartość</th>
              </tr>
            </thead>
            <tbody>
              {kafel.parametry.map((p) => (
                <tr key={p.nazwa} className={p.brak ? 'row-warn' : undefined}>
                  <td data-label="Parametr">
                    {p.nazwa}
                    {p.wymagany && <span className="muted"> (wymagany)</span>}
                  </td>
                  <td data-label="Wartość">{p.brak ? <span className="pub-blad">brak, uzupełnij</span> : (p.wartosc ?? '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h3 className="small">Zdjęcia ({kafel.zdjecia.length})</h3>
      {kafel.zdjecia.length ? (
        <ul className="pub-zdjecia">
          {kafel.zdjecia.slice(0, 8).map((z, i) => (
            <li key={`${z.url}-${i}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- podgląd adresów kanału (także zewnętrznych) */}
              <img src={z.url} alt={`Zdjęcie ${i + 1}`} width={72} height={72} loading="lazy" />
              {!z.publiczny && <span className="pub-blad small">bez adresu w sieci</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="pub-blad small">Produkt nie ma zdjęć.</p>
      )}
      <details className="pub-opis">
        <summary className="small">Opis oferty</summary>
        {kafel.opis.length ? (
          kafel.opis.map((f, i) =>
            f.typ === 'tekst' ? (
              // treść oczyszczona w lib/oferty (tylko p, b, h1, h2, ul, ol, li bez atrybutów, tekst escapowany)
              <div key={i} className="small" dangerouslySetInnerHTML={{ __html: f.html }} />
            ) : null,
          )
        ) : (
          <p className="pub-blad small">Brak opisu.</p>
        )}
      </details>
    </Karta>
  )
}
