'use client'
// Ustawienia → Agenci AI → sekcja „Dostawca AI”: klucz do tekstów (Anthropic: opis produktu), klucz do
// obrazów (Kie.ai: packshot), model i wyłącznik packshotu. Klucze wpisane w pole idą do zaszyfrowanych sekretów firmy;
// ekran pokazuje tylko, skąd jest klucz („zapisany w firmie”, „z ustawień serwera”, „usługa Kompletora”).
import { useActionState } from 'react'
import { zapiszDostawceAiAkcja, type StanDostawcyAi } from './akcje'

const START: StanDostawcyAi = { ok: false, komunikat: null }

export type ZrodloKlucza = 'firma' | 'platforma' | 'env' | null

const OPIS_ZRODLA: Record<Exclude<ZrodloKlucza, null>, string> = {
  firma: 'zapisany w firmie',
  env: 'z ustawień serwera (zmienna środowiska)',
  platforma: 'usługa Kompletora (koszt z salda firmy)',
}

function Zrodlo({ z }: { z: ZrodloKlucza }) {
  return z ? <span className="chip leaf">{OPIS_ZRODLA[z]}</span> : <span className="chip">brak klucza</span>
}

export function DostawcaAi({ model, packshot, asystent, modele, tekst, obrazy }: { model: string; packshot: boolean; asystent: boolean; modele: readonly { id: string; etykieta: string }[]; tekst: ZrodloKlucza; obrazy: ZrodloKlucza }) {
  const [state, action, pending] = useActionState(zapiszDostawceAiAkcja, START)
  const inv = (f: string) => (state.field === f ? { 'aria-invalid': true as const, 'aria-describedby': 'ai-blad' } : {})
  return (
    <form action={action} className="stack" aria-label="Dostawca AI">
      {state.komunikat && (
        <div className={state.ok ? 'banner leaf-soft' : 'banner red'} role={state.ok ? 'status' : 'alert'} id={state.ok ? undefined : 'ai-blad'}>
          <div>{state.komunikat}</div>
        </div>
      )}
      <div className="field">
        <label htmlFor="ai-model">Model do tekstów (opis produktu, asystent)</label>
        <select className="input" id="ai-model" name="model" defaultValue={model} {...inv('model')}>
          {modele.map((m) => (
            <option key={m.id} value={m.id}>
              {m.etykieta}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="ai-klucz">
          Klucz API Anthropic (teksty) <Zrodlo z={tekst} />
        </label>
        <input className="input mono" id="ai-klucz" name="klucz" type="password" autoComplete="off" placeholder={tekst ? 'zostaw puste, żeby nie zmieniać' : 'sk-ant-…'} {...inv('klucz')} />
        <span className="muted small">Klucz z console.anthropic.com → API Keys. Zapisujemy go zaszyfrowany; nikt go już nie zobaczy w panelu.</span>
      </div>
      <div className="field">
        <label htmlFor="ai-obrazy">
          Klucz API Kie.ai (obrazy: packshot) <Zrodlo z={obrazy} />
        </label>
        <input className="input mono" id="ai-obrazy" name="kluczObrazow" type="password" autoComplete="off" placeholder={obrazy ? 'zostaw puste, żeby nie zmieniać' : 'klucz z kie.ai'} {...inv('kluczObrazow')} />
        <span className="muted small">Klucz z kie.ai → API Key. Jeden packshot kosztuje u Kie.ai ok. 4 kredytów.</span>
      </div>
      <label className="small">
        <input type="checkbox" name="packshot" defaultChecked={packshot} /> Packshot AI włączony: na karcie produktu przy zdjęciu jest przycisk „Packshot (AI)”, który robi z niego zdjęcie
        na białym tle i dodaje je jako nowe zdjęcie produktu
      </label>
      <label className="small">
        <input type="checkbox" name="asystent" defaultChecked={asystent} /> Asystent „Zapytaj” włączony: na każdym ekranie panelu w prawym dolnym rogu jest przycisk „Zapytaj”, który odpowiada na
        pytania o obsługę Kompletora wyłącznie z Pomocy. Do AI idzie tylko pytanie (bez e-maili i telefonów) i fragmenty Pomocy, nigdy dane zamówień ani klientów
        {tekst === null && <span className="muted"> (wymaga klucza Anthropic: bez klucza przycisk „Zapytaj” się nie pokazuje)</span>}
        {tekst === 'platforma' && <span className="muted"> (pytania, na które asystent odpowiada z AI, liczą się do zużycia z salda firmy)</span>}
      </label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn primary" type="submit" name="co" value="zapisz" disabled={pending}>
          {pending ? 'Zapisuję…' : 'Zapisz'}
        </button>
        {tekst === 'firma' && (
          <button className="btn ghost" type="submit" name="co" value="usun-tekst" disabled={pending} onClick={(e) => !window.confirm('Usunąć klucz Anthropic z firmy? Podpowiedź opisu przestanie działać.') && e.preventDefault()}>
            Usuń klucz Anthropic
          </button>
        )}
        {obrazy === 'firma' && (
          <button className="btn ghost" type="submit" name="co" value="usun-obrazy" disabled={pending} onClick={(e) => !window.confirm('Usunąć klucz Kie.ai z firmy? Packshot przestanie działać.') && e.preventDefault()}>
            Usuń klucz Kie.ai
          </button>
        )}
      </div>
    </form>
  )
}
