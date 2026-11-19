'use client'
// Przyciski karty zwrotu. Funkcja nie znika: przy braku uprawnienia albo wyłączonej korekcie przycisk
// zostaje widoczny i nieaktywny z powodem (zasada fal). Wynik akcji = toast albo komunikat pod formularzem.
import { type ReactNode, useActionState, useState, useTransition } from 'react'
import { Baner, Potwierdzenie, Przycisk, type WariantPrzycisku, useToast } from '@/app/ui'
import type { PozycjaZwrotu } from '@/lib/zwroty/karta'
import { dodajZdjecie, odbierzZwrot, odrzucZwrot, ponowKorekte, type WynikAkcjiZwrotu, zakonczPozaKompletorem, zlecKorekte } from '../akcje'

const START: WynikAkcjiZwrotu = { blad: null }

/** Przycisk z pytaniem „Na pewno?” bez formularza (akcja w `onTak`). */
function ZPytaniem({ pytanie, tak, onTak, wariant, ladowanie, powodWylaczenia, children }: { pytanie: ReactNode; tak: string; onTak: () => void; wariant: WariantPrzycisku; ladowanie: boolean; powodWylaczenia?: string; children: ReactNode }) {
  const [otwarte, setOtwarte] = useState(false)
  return (
    <>
      <Przycisk wariant={wariant} ladowanie={ladowanie} powodWylaczenia={powodWylaczenia} onClick={() => setOtwarte(true)}>
        {children}
      </Przycisk>
      <Potwierdzenie otwarte={otwarte} tytul="Na pewno?" tak={tak} wariant={wariant === 'niebezpieczny' ? 'niebezpieczny' : 'glowny'} onNie={() => setOtwarte(false)} onTak={() => { setOtwarte(false); onTak() }}>
        {pytanie}
      </Potwierdzenie>
    </>
  )
}

export function OdbiorPaczki({ returnId, pozycje, powodWylaczenia, stanKompletora }: { returnId: string; pozycje: PozycjaZwrotu[]; powodWylaczenia: string | null; stanKompletora: boolean }) {
  const [state, action, pending] = useActionState(odbierzZwrot, START)
  return (
    <form action={action} className="zw-odbior" aria-label="Odbiór paczki">
      <input type="hidden" name="zwrot" value={returnId} />
      <table className="tbl cards zw-pozycje">
        <thead>
          <tr>
            <th scope="col">Pozycja</th>
            <th scope="col" className="right">
              Ilość
            </th>
            <th scope="col">Co z towarem</th>
          </tr>
        </thead>
        <tbody>
          {pozycje.map((p) => (
            <tr key={p.id}>
              <td data-label="Pozycja">
                {p.nazwa}
                {p.sku && <span className="sub mono">{p.sku}</span>}
              </td>
              <td data-label="Ilość" className="right num">
                {p.qty} {p.jednostka}
              </td>
              <td data-label="Co z towarem">
                <fieldset className="zw-dyspozycja">
                  <legend className="sr">Co z towarem: {p.nazwa}</legend>
                  <label className="zw-radio">
                    <input type="radio" name={`d:${p.id}`} value="NA_STAN" defaultChecked required /> Na stan
                  </label>
                  <label className="zw-radio">
                    <input type="radio" name={`d:${p.id}`} value="USZKODZONE" /> Uszkodzone
                  </label>
                </fieldset>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        {stanKompletora
          ? '„Na stan” wraca do sprzedaży od razu. „Uszkodzone” nie wraca do sprzedaży i zostaje w historii ruchów.'
          : '„Na stan” wróci do sprzedaży po korekcie faktury (odczyt stanu z programu). „Uszkodzone” po korekcie wychodzi ze sprzedaży od razu, w programie zrób dokument rozchodu.'}
      </p>
      {state.blad && <Baner ton="blad">{state.blad}</Baner>}
      <Przycisk type="submit" wariant="glowny" ladowanie={pending} powodWylaczenia={powodWylaczenia ?? undefined}>
        Odbierz paczkę
      </Przycisk>
    </form>
  )
}

export function Korekta({ returnId, zlecenie, recznie, powod, uprawnienie, blad, ukryjZlecenie, potwierdzenie }: { returnId: string; zlecenie: boolean; recznie: boolean; powod: string | null; uprawnienie: boolean; blad: boolean; /** korekta już w kolejce: bez drugiego „Zleć” */ ukryjZlecenie?: boolean; /** ponowienie po niewiadomej tylko po zaznaczeniu „sprawdziłem w programie” */ potwierdzenie?: boolean }) {
  const [pending, start] = useTransition()
  const [sprawdzone, setSprawdzone] = useState(false)
  const [numer, setNumer] = useState('')
  const toast = useToast()
  const brak = uprawnienie ? null : 'Brak uprawnienia „Zwroty: zlecenie korekty faktury”'
  const run = (f: () => Promise<WynikAkcjiZwrotu>, ok: string) =>
    start(async () => {
      const r = await f()
      if (r.blad) toast.blad(r.blad)
      else toast.sukces(ok)
    })
  return (
    <div className="zw-korekta">
      {blad ? (
        <>
          {potwierdzenie && (
            <label className="checkrow">
              <input type="checkbox" checked={sprawdzone} onChange={(e) => setSprawdzone(e.target.checked)} />
              <span>Sprawdziłem w programie do faktur: tej korekty tam nie ma</span>
            </label>
          )}
          <Przycisk
            wariant="glowny"
            ladowanie={pending}
            powodWylaczenia={brak ?? (!zlecenie ? (powod ?? 'Korekty nie da się teraz ponowić') : potwierdzenie && !sprawdzone ? 'Najpierw sprawdź w programie do faktur, czy tej korekty nie ma, i zaznacz pole wyżej' : undefined)}
            onClick={() => run(() => ponowKorekte(returnId, !!potwierdzenie && sprawdzone), 'Korekta wróciła do kolejki')}
          >
            Ponów korektę
          </Przycisk>
        </>
      ) : ukryjZlecenie ? null : (
        <Przycisk wariant="glowny" ladowanie={pending} powodWylaczenia={brak ?? (zlecenie ? undefined : (powod ?? 'Korekty nie da się teraz zlecić'))} onClick={() => run(() => zlecKorekte(returnId), 'Korekta zlecona: program do faktur wystawi ją w ciągu kilku minut')}>
          Zleć korektę faktury
        </Przycisk>
      )}
      {!zlecenie && powod && <p className="muted small">{powod}</p>}
      {recznie && (
        <div className="zw-recznie">
          <div className="field">
            <label htmlFor="zw-numer-korekty">
              Numer korekty w programie <span className="muted small">(opcjonalnie)</span>
            </label>
            <input className="input" id="zw-numer-korekty" value={numer} maxLength={60} onChange={(e) => setNumer(e.target.value)} />
          </div>
          <ZPytaniem
            wariant="drugorzedny"
            ladowanie={pending}
            powodWylaczenia={brak ?? undefined}
            pytanie="Zwrot zostanie zakończony. Pozycje „na stan” trafią na listę „korekta bez PZ” do potwierdzenia, uszkodzone wyjdą ze sprzedaży od razu."
            tak="Zakończ zwrot"
            onTak={() => run(() => zakonczPozaKompletorem(returnId, numer), 'Zwrot zakończony')}
          >
            Korekta wystawiona poza Kompletorem
          </ZPytaniem>
        </div>
      )}
    </div>
  )
}

export function Odrzuc({ returnId, powodWylaczenia }: { returnId: string; powodWylaczenia: string | null }) {
  const [pending, start] = useTransition()
  const [powod, setPowod] = useState('')
  const toast = useToast()
  return (
    <div className="zw-odrzuc">
      <div className="field">
        <label htmlFor="zw-powod-odrzucenia">Dlaczego odrzucasz</label>
        <input className="input" id="zw-powod-odrzucenia" value={powod} maxLength={500} onChange={(e) => setPowod(e.target.value)} />
      </div>
      <ZPytaniem
        wariant="niebezpieczny"
        ladowanie={pending}
        powodWylaczenia={powodWylaczenia ?? undefined}
        pytanie="Zwrot zostanie odrzucony. Stan magazynu się nie zmieni."
        tak="Odrzuć zwrot"
        onTak={() =>
          start(async () => {
            const r = await odrzucZwrot(returnId, powod)
            if (r.blad) toast.blad(r.blad)
            else toast.sukces('Zwrot odrzucony')
          })
        }
      >
        Odrzuć zwrot
      </ZPytaniem>
    </div>
  )
}

export function DodajZdjecie({ returnId }: { returnId: string }) {
  const [state, action, pending] = useActionState(dodajZdjecie, START)
  return (
    <form action={action} className="zw-zdjecie-form" aria-label="Dodaj zdjęcie">
      <input type="hidden" name="zwrot" value={returnId} />
      <div className="field">
        <label htmlFor="zw-zdjecie-k">Zdjęcie (JPEG, PNG albo webp, do 10 MB)</label>
        <input className="input" id="zw-zdjecie-k" name="zdjecie" type="file" accept="image/jpeg,image/png,image/webp" required />
        <span className="muted small">Fotografuj towar, nie etykietę z adresem klienta. Zdjęcie widzą tylko osoby, które przyjmują zwroty.</span>
      </div>
      {state.blad && <Baner ton="blad">{state.blad}</Baner>}
      <Przycisk type="submit" wariant="drugorzedny" ladowanie={pending}>
        Dodaj zdjęcie
      </Przycisk>
    </form>
  )
}
