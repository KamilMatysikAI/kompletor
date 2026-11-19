// Tabela nadpisań powiązań ofert (dane/nadpisania-ofert/<id firmy>.csv albo prywatna nakładka
// prywatne/nadpisania-ofert/<id firmy>.csv) — do czasu adaptera Allegro (F2).
// plik per firma, konto kanału sprawdzane z konfiguracją firmy w bazie (nie ze stałych w kodzie).
// Po co: oferta Allegro powiązana w BL po fakcie ma w historii getOrders pozycje z product_id = 0 na zawsze,
// więc z samej sprzedaży wychodzi „bez powiązania”, choć BL już zdejmuje z niej stan (22.10.2026).
// Plik zawiera wyłącznie id ofert i SKU produktów — żadnych danych klientów.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { offerMapKey, sellableBl, type OfferResult } from './mapowanie'
import { fileURLToPath } from 'node:url'
import { NonRetryableError } from '../bledy'
import type { BlProd, ChannelT } from './normalizacja'

export interface OfferOverride {
  channel: ChannelT
  accountId: string
  externalId: string
  sku: string
  note: string
}

/** Katalog plików firm liczony od katalogu repo (nie od bieżącego katalogu procesu — worker w Coolify, Harmonogram). */
const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const OVERRIDES_DIR = path.join(REPO_DIR, 'dane', 'nadpisania-ofert')
/** Prywatna nakładka (`prywatne/nadpisania-ofert`, poza repo i obrazem; w kontenerze plik montowany). */
export const OVERRIDES_PRIVATE_DIR = path.join(REPO_DIR, 'prywatne', 'nadpisania-ofert')

/**
 * Plik nadpisań firmy: katalog z `KOMPLETOR_NADPISANIA_KATALOG` (gdy ustawiony), inaczej `dane/nadpisania-ofert/<id>.csv`,
 * a gdy go nie ma, a jest `prywatne/nadpisania-ofert/<id>.csv`, ten z prywatnej nakładki.
 */
export function overridesFileOf(organizationId: string, env: Record<string, string | undefined> = process.env): string {
  if (!/^[a-z0-9_-]{1,64}$/.test(organizationId)) throw new NonRetryableError('zły identyfikator firmy dla pliku nadpisań')
  const katalog = env['KOMPLETOR_NADPISANIA_KATALOG']?.trim()
  if (katalog) return path.join(path.resolve(katalog), `${organizationId}.csv`)
  const publiczny = path.join(OVERRIDES_DIR, `${organizationId}.csv`)
  const prywatny = path.join(OVERRIDES_PRIVATE_DIR, `${organizationId}.csv`)
  return !existsSync(publiczny) && existsSync(prywatny) ? prywatny : publiczny
}

/**
 * CSV `kanal;konto;id_oferty;sku;uwagi` (nagłówek, `#` = komentarz). Zły wiersz = błąd, nie cichy pominięty.
 * `knownAccounts` — konta kanałów firmy „<kanał>|<konto>” (ChannelConfig; `Object.keys(channelMapOf(cfg).names)`).
 * Wiersze dla `BL_INNE`, `RECZNE` i `EASYTOOLS` są odrzucane jako nieznane konto: te kanały nie mają kont
 * w ChannelConfig (konto z BL to „<źródło>:<id>” albo numer ręcznego źródła), a tabela łata tylko historię ofert
 * kont firmy (Allegro). Plik nie zatwierdza propozycji Woo po SKU — to robi panel.
 */
export function parseOfferOverrides(text: string, knownAccounts: ReadonlySet<string>): OfferOverride[] {
  const out: OfferOverride[] = []
  const seen = new Set<string>()
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  lines.forEach((line, i) => {
    const t = line.trim()
    if (!t || t.startsWith('#') || i === 0) return
    const [channel, accountId, externalId, sku, ...rest] = t.split(';').map((x) => x.trim())
    if (!channel || !accountId || !externalId || !sku) {
      throw new NonRetryableError(`nadpisania ofert, wiersz ${i + 1}: oczekiwane „kanal;konto;id_oferty;sku;uwagi”`)
    }
    if (!knownAccounts.has(`${channel}|${accountId}`)) {
      throw new NonRetryableError(`nadpisania ofert, wiersz ${i + 1}: nieznane konto kanału ${channel} ${accountId}`)
    }
    const key = offerMapKey(channel as ChannelT, accountId, externalId)
    if (seen.has(key)) throw new NonRetryableError(`nadpisania ofert, wiersz ${i + 1}: oferta ${externalId} powtórzona`)
    seen.add(key)
    out.push({ channel: channel as ChannelT, accountId, externalId, sku, note: rest.join(';') })
  })
  return out
}

/**
 * Wczytuje tabelę nadpisań firmy. Plik wskazany jawnie (`NADPISANIA_OFERT` / argument) musi istnieć — brak = błąd
 * (bez niego oferty powiązane po fakcie zostałyby wyłączone). Domyślny plik firmy (`dane/nadpisania-ofert/<id>.csv`,
 * ścieżka od repo, nie od cwd) jest opcjonalny: firma bez historii z BL nie ma czego łatać.
 */
export function loadOfferOverrides(organizationId: string, knownAccounts: ReadonlySet<string>, file = process.env['NADPISANIA_OFERT']): OfferOverride[] {
  const abs = path.resolve(file || overridesFileOf(organizationId))
  if (!existsSync(abs)) {
    if (file) throw new NonRetryableError(`brak pliku nadpisań ofert ${abs} (NADPISANIA_OFERT)`)
    return []
  }
  return parseOfferOverrides(readFileSync(abs, 'utf8'), knownAccounts)
}

/**
 * Nakłada nadpisania na wynik mapowania: oferta → jeden produkt BL po SKU (jednoznaczny i założony w systemie).
 * Oferty spoza okna sprzedaży dostają wiersz bez sprzedaży. Zwraca problemy do raportu.
 */
export function applyOfferOverrides(
  offers: OfferResult[],
  overrides: OfferOverride[],
  bl: BlProd[],
  known: Set<string>,
): string[] {
  const problems: string[] = []
  const bySku = new Map<string, string[]>()
  for (const p of sellableBl(bl)) if (p.sku) bySku.set(p.sku, [...(bySku.get(p.sku) ?? []), p.id])
  const byKey = new Map(offers.map((o) => [offerMapKey(o.channel, o.accountId, o.externalId), o]))
  for (const ov of overrides) {
    const ids = bySku.get(ov.sku) ?? []
    const label = `${ov.channel} ${ov.externalId} → ${ov.sku}`
    if (ids.length !== 1) {
      problems.push(`${label}: SKU ${ids.length ? `wskazuje ${ids.length} produkty BL` : 'nie istnieje w katalogu BL'} — nadpisanie pominięte`)
      continue
    }
    const blId = ids[0]!
    if (!known.has(blId)) {
      problems.push(`${label}: produkt BL ${blId} nie ma towaru w wFirmie — nadpisanie pominięte`)
      continue
    }
    const existing = byKey.get(offerMapKey(ov.channel, ov.accountId, ov.externalId))
    const note = `powiązanie z nadpisania (tabela nadpisań firmy${ov.note ? `: ${ov.note}` : ''})`
    if (existing) {
      // Źródłem prawdy o bieżącym powiązaniu jest BL; tabela tylko łata historię z product_id = 0.
      if (existing.state === 'MAPPED' && existing.source !== 'OVERRIDE') {
        if (existing.blProductIds[0] !== blId) {
          // Woo dopasowane po SKU to propozycja, nie wskazanie z BL — zatwierdza ją panel, nie CSV.
          const msg =
            existing.source === 'SKU' && ov.channel === 'WOO'
              ? `${label}: propozycja po SKU wskazuje produkt ${existing.blProductIds[0]}, nadpisanie ${blId} — propozycję zatwierdza albo odrzuca panel, CSV jej nie zatwierdza; usuń albo popraw wiersz w CSV`
              : `${label}: BL (${existing.source}) wskazuje produkt ${existing.blProductIds[0]}, nadpisanie ${blId} — wygrywa BL, usuń albo popraw wiersz w CSV`
          problems.push(msg)
          existing.notes.push(msg)
        } else {
          existing.notes.push('nadpisanie zgodne z BL (wiersz w CSV można usunąć)')
        }
        continue
      }
      if (existing.state === 'AMBIGUOUS') {
        problems.push(`${label}: oferta wieloznaczna w BL (${existing.blProductIds.join(', ')}) — rozstrzygnięta nadpisaniem na ${blId}, sprawdź`)
      }
      existing.state = 'MAPPED'
      existing.source = 'OVERRIDE'
      existing.blProductIds = [blId]
      existing.sku ??= ov.sku
      existing.notes.push(note)
    } else {
      const r: OfferResult = {
        channel: ov.channel,
        accountId: ov.accountId,
        externalId: ov.externalId,
        sku: ov.sku,
        ean: null,
        name: bl.find((b) => b.id === blId)?.name ?? ov.sku,
        state: 'MAPPED',
        source: 'OVERRIDE',
        blProductIds: [blId],
        sales90dQty: 0,
        sales90dOrders: 0,
        lastSoldAt: null,
        notes: [note, 'bez sprzedaży w oknie'],
      }
      offers.push(r)
      byKey.set(offerMapKey(r.channel, r.accountId, r.externalId), r)
    }
  }
  return problems
}
