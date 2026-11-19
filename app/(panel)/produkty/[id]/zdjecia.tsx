'use client'
// Karta produktu → zakładka „Zdjęcia” (przeglądu): wgranie, kolejność, główne,
// usunięcie. Komunikat po akcji jest stanem akcji (useActionState, jak w EdycjaKarty), nie parametrem adresu: znika po
// odświeżeniu strony i nie trafia do linku wysłanego komuś dalej.
import { useActionState } from 'react'
import { zdjecieUrl } from '@/lib/produkty/zdjecia-url'
import { akcjaZdjec, type StanZdjec } from './produkt-akcje'
import { PrzyciskUsunZdjecie } from './edycja'

const START: StanZdjec = { ok: false, komunikat: null }

export interface ZdjecieKarty {
  id: string
  sourceUrl: string | null
}

function Komunikat({ state }: { state: StanZdjec }) {
  if (!state.komunikat) return null
  return (
    <div className={state.ok ? 'banner leaf-soft' : 'banner red'} role={state.ok ? 'status' : 'alert'}>
      <div>{state.komunikat}</div>
    </div>
  )
}

export type StanPackshotu = 'wylaczony' | 'brak-klucza' | 'gotowy'

export function ZdjeciaProduktu({ produkt, tytul, zdjecia, canEdit, max, packshot }: { produkt: string; tytul: string; zdjecia: ZdjecieKarty[]; canEdit: boolean; max: number; packshot: StanPackshotu }) {
  // jedna akcja na zakładkę (wgranie i zmiany): komunikat zawsze z ostatniej
  const [state, akcja, pending] = useActionState(akcjaZdjec, START)
  return (
    <>
      <Komunikat state={state} />
      {zdjecia.length === 0 ? (
        <p className="muted small">Brak zdjęć.</p>
      ) : (
        <ul className="pr-gal">
          {zdjecia.map((z, i) => (
            <li key={z.id} className="pr-img">
              <a href={zdjecieUrl(z.id, 'o')} target="_blank" rel="noopener">
                <img src={zdjecieUrl(z.id, 'm')} alt={`Zdjęcie ${i + 1}: ${tytul}`} width={160} height={160} loading="lazy" />
              </a>
              <div className="small">
                {i === 0 ? <span className="chip leaf">główne</span> : <span className="muted">{i + 1}</span>}
                {z.sourceUrl?.startsWith('packshot:') ? <span className="muted"> · packshot AI</span> : z.sourceUrl && <span className="muted"> · z oferty sklepu</span>}
              </div>
              {canEdit && (
                <form action={akcja} className="pr-img-akcje">
                  <input type="hidden" name="zdjecie" value={z.id} />
                  {i > 0 && (
                    <button className="btn small" type="submit" name="co" value="glowne" disabled={pending}>
                      Główne
                    </button>
                  )}
                  {i > 0 && (
                    <button className="btn ghost small" type="submit" name="co" value="w-lewo" aria-label={`Przesuń zdjęcie ${i + 1} wcześniej`} disabled={pending}>
                      ←
                    </button>
                  )}
                  {i < zdjecia.length - 1 && (
                    <button className="btn ghost small" type="submit" name="co" value="w-prawo" aria-label={`Przesuń zdjęcie ${i + 1} dalej`} disabled={pending}>
                      →
                    </button>
                  )}
                  {packshot === 'gotowy' && !z.sourceUrl?.startsWith('packshot:') && zdjecia.length < max && (
                    <button className="btn ghost small" type="submit" name="co" value="packshot" disabled={pending} aria-label={`Packshot AI ze zdjęcia ${i + 1}`}>
                      Packshot (AI)
                    </button>
                  )}
                  <PrzyciskUsunZdjecie n={i + 1} />
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && zdjecia.length < max && (
        <form action={akcja} className="np-sku pr-mt" aria-label="Wgraj zdjęcia">
          <input type="hidden" name="produkt" value={produkt} />
          <input type="hidden" name="co" value="wgraj" />
          <div className="field">
            <label htmlFor="k-zdj">
              Dodaj zdjęcia (JPG, PNG, WEBP, do 15 MB każde; jeszcze {max - zdjecia.length})
            </label>
            <input className="input" id="k-zdj" name="zdjecia" type="file" multiple accept="image/jpeg,image/png,image/webp" required />
          </div>
          <button className="btn primary" type="submit" disabled={pending}>
            {pending ? 'Zapisuję…' : 'Wgraj'}
          </button>
        </form>
      )}
      {canEdit && packshot !== 'gotowy' && (
        <p className="muted small pr-mt">
          Packshot (zdjęcie produktu na białym tle zrobione przez AI z Twojego zdjęcia){' '}
          {packshot === 'wylaczony' ? 'jest wyłączony' : 'czeka na klucz Kie.ai'}: włączysz go w Ustawienia → Integracje i agenci AI → Agenci AI → Dostawca AI.
        </p>
      )}
      {canEdit && packshot === 'gotowy' && (
        <p className="muted small pr-mt">Packshot (AI): przycisk przy zdjęciu robi z niego nowe zdjęcie na białym tle; oryginał zostaje. Do AI idzie tylko to zdjęcie.</p>
      )}
    </>
  )
}
