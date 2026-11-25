'use client'
// Produkty → Kategorie: drzewo kategorii firmy w tabeli (wcięcie = poziom) z liczbą produktów i oknem „Zmień”:
// nazwa, przeniesienie pod inną kategorię, usunięcie z wyborem, dokąd idą produkty. Kolejność rodzeństwa strzałkami.
// Jedno okno na cały ekran (nie na wiersz), żeby drzewo z setkami kategorii nie niosło list wyboru w każdym wierszu.
import Link from 'next/link'
import { useState, type CSSProperties } from 'react'
import { Modal, Przycisk, PrzyciskPotwierdz, PoleTekstowe, Wybor } from '@/app/ui'
import { przeniesAkcja, przesunAkcja, usunAkcja, zmienNazweAkcja } from './akcje'

export interface KategoriaUi {
  id: string
  parentId: string | null
  name: string
  path: string
  depth: number
  produktow: number
  wGalezi: number
  podkategorii: number
}

const SEP = ' > '
const int = (n: number) => n.toLocaleString('pl-PL')

export function DrzewoKategorii({ drzewo, canEdit, maxGlebokosc }: { drzewo: KategoriaUi[]; canEdit: boolean; maxGlebokosc: number }) {
  const [edytowana, setEdytowana] = useState<KategoriaUi | null>(null)
  const pierwsza = new Set<string>()
  const ostatnia = new Set<string>()
  const wgRodzica = new Map<string | null, string[]>()
  for (const k of drzewo) wgRodzica.set(k.parentId, [...(wgRodzica.get(k.parentId) ?? []), k.id])
  for (const ids of wgRodzica.values()) {
    pierwsza.add(ids[0]!)
    ostatnia.add(ids.at(-1)!)
  }
  return (
    <>
      <table className="tbl cards kat-drzewo">
        <thead>
          <tr>
            <th scope="col">Kategoria</th>
            <th scope="col" className="right">
              Produkty
            </th>
            {canEdit && <th scope="col">Akcje</th>}
          </tr>
        </thead>
        <tbody>
          {drzewo.map((k) => (
            <tr key={k.id} id={`k-${k.id}`}>
              <td data-label="Kategoria">
                <span className="kat-nazwa" style={{ '--kat-poziom': k.depth - 1 } as CSSProperties} title={k.path}>
                  {k.depth > 1 && <span className="muted" aria-hidden="true">└ </span>}
                  <b>{k.name}</b>
                </span>
                {k.podkategorii > 0 && <span className="muted small"> · podkategorii: {k.podkategorii}</span>}
              </td>
              <td data-label="Produkty" className="right num">
                <Link href={`/produkty?kategoria=${k.id}`} title="Lista produktów tej kategorii razem z podkategoriami">
                  {int(k.wGalezi)}
                </Link>
                {k.podkategorii > 0 && <span className="muted small"> (wprost {int(k.produktow)})</span>}
              </td>
              {canEdit && (
                <td data-label="Akcje">
                  <div className="actions kat-akcje">
                  <form action={przesunAkcja} className="inline">
                    <input type="hidden" name="id" value={k.id} />
                    <button className="btn small" type="submit" name="kierunek" value="gora" disabled={pierwsza.has(k.id)} aria-label={`${k.name}: wyżej`} title="Wyżej">
                      ↑
                    </button>
                    <button className="btn small" type="submit" name="kierunek" value="dol" disabled={ostatnia.has(k.id)} aria-label={`${k.name}: niżej`} title="Niżej">
                      ↓
                    </button>
                  </form>
                  <Przycisk rozmiar="sm" onClick={() => setEdytowana(k)}>
                    Zmień
                  </Przycisk>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {canEdit && edytowana && <OknoKategorii k={edytowana} drzewo={drzewo} maxGlebokosc={maxGlebokosc} onZamknij={() => setEdytowana(null)} />}
    </>
  )
}

function OknoKategorii({ k, drzewo, maxGlebokosc, onZamknij }: { k: KategoriaUi; drzewo: KategoriaUi[]; maxGlebokosc: number; onZamknij: () => void }) {
  // przeniesienie: bez samej kategorii, jej podkategorii i rodziców, pod którymi drzewo przekroczyłoby limit poziomów
  const wysokosc = Math.max(0, ...drzewo.filter((x) => x.path.startsWith(k.path + SEP)).map((x) => x.depth - k.depth))
  const doPrzeniesienia = drzewo.filter((x) => x.id !== k.id && !x.path.startsWith(k.path + SEP) && x.depth + 1 + wysokosc <= maxGlebokosc)
  const rodzic = drzewo.find((x) => x.id === k.parentId) ?? null
  const celeUsuniecia = drzewo.filter((x) => x.id !== k.id)
  return (
    <Modal otwarty onZamknij={onZamknij} tytul={`Kategoria: ${k.path}`}>
      <form action={zmienNazweAkcja} className="filters">
        <input type="hidden" name="id" value={k.id} />
        <PoleTekstowe id="kat-nazwa" name="nazwa" etykieta="Nazwa" defaultValue={k.name} required maxLength={80} />
        <Przycisk type="submit">Zapisz nazwę</Przycisk>
      </form>

      <form action={przeniesAkcja} className="filters pr-mt">
        <input type="hidden" name="id" value={k.id} />
        <Wybor
          id="kat-rodzic"
          name="rodzic"
          etykieta="Kategoria nadrzędna"
          defaultValue={k.parentId ?? ''}
          opcje={[{ wartosc: '', etykieta: 'najwyższy poziom' }, ...doPrzeniesienia.map((x) => ({ wartosc: x.id, etykieta: x.path }))]}
          pomoc={k.podkategorii ? 'Podkategorie przenoszą się razem z nią, produkty zostają w swoich kategoriach.' : 'Produkty zostają w tej kategorii.'}
        />
        <Przycisk type="submit">Przenieś</Przycisk>
      </form>

      <form action={usunAkcja} className="pr-mt">
        <input type="hidden" name="id" value={k.id} />
        {k.podkategorii > 0 ? (
          <p className="muted small">Usunąć można kategorię bez podkategorii: najpierw przenieś albo usuń jej podkategorie ({k.podkategorii}).</p>
        ) : (
          <div className="filters">
            {k.produktow > 0 && (
              <Wybor
                id="kat-cel"
                name="cel"
                etykieta={`Produkty tej kategorii (${int(k.produktow)}) przejdą do`}
                defaultValue={rodzic ? 'rodzic' : ''}
                required
                opcje={[
                  ...(rodzic ? [{ wartosc: 'rodzic', etykieta: `kategorii nadrzędnej: ${rodzic.path}` }] : [{ wartosc: '', etykieta: 'Wybierz…' }]),
                  ...celeUsuniecia.filter((x) => x.id !== rodzic?.id).map((x) => ({ wartosc: x.id, etykieta: x.path })),
                  { wartosc: 'brak', etykieta: 'bez kategorii' },
                ]}
              />
            )}
            <PrzyciskPotwierdz
              wariant="niebezpieczny"
              tytul="Usunąć kategorię?"
              pytanie={k.produktow > 0 ? `Kategoria „${k.path}” zniknie z drzewa, a jej produkty (${int(k.produktow)}) przejdą do wybranej kategorii. Zmiana trafi do historii każdego produktu.` : `Kategoria „${k.path}” zniknie z drzewa. Nie ma w niej produktów.`}
            >
              Usuń kategorię
            </PrzyciskPotwierdz>
          </div>
        )}
      </form>
    </Modal>
  )
}
