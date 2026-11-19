'use client'
// Czytnik kodów na ekranach panelu bez otwartego okna pakowania. Czytnik „pisze” jak klawiatura: szybki
// ciąg znaków i Enter. Ekran łapie go z całego dokumentu (faza przechwytywania, żeby Enter z czytnika nie otwierał
// przy okazji wiersza z fokusem), gdy fokus nie jest w polu tekstowym ani w oknie dialogowym. Decyzje:
// lib/stanowisko/czytnik.ts (bufor) i lib/stanowisko/czytnik-panelu.ts (gdzie łapać, wklejanie).
import { useEffect, useRef } from 'react'
import { krokCzytnika, PUSTY_BUFOR, type BuforCzytnika } from '@/lib/stanowisko/czytnik'
import { decyzjaWklejenia, przechwytujKlawisze, type CelZdarzenia } from '@/lib/stanowisko/czytnik-panelu'

const DIALOG = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'

function opis(el: EventTarget | null, poleSzukania?: string): CelZdarzenia | null {
  if (!(el instanceof HTMLElement)) return null
  return {
    tagName: el.tagName,
    type: el instanceof HTMLInputElement ? el.type : undefined,
    edytowalny: el.isContentEditable,
    wDialogu: !!el.closest(DIALOG),
    poleSzukania: !!poleSzukania && el.id === poleSzukania,
  }
}

const dialogOtwarty = () => !!document.querySelector(DIALOG)

export function CzytnikKodow({
  onSkan,
  onWklej,
  poleSzukania,
}: {
  onSkan: (tekst: string) => void
  /** Wklejenie poza polami albo w pole „Szukaj” (`poleSzukania` = jego id); bez tego wklejanie niczego nie robi. */
  onWklej?: (tekst: string, gdzie: 'pole_szukania' | 'poza') => void
  poleSzukania?: string
}) {
  const skan = useRef(onSkan)
  const wklej = useRef(onWklej)
  useEffect(() => {
    skan.current = onSkan
    wklej.current = onWklej
  }, [onSkan, onWklej])
  const bufor = useRef<BuforCzytnika>(PUSTY_BUFOR)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      const lap = przechwytujKlawisze(opis(e.target), dialogOtwarty())
      const k = krokCzytnika(bufor.current, { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, teraz: performance.now(), wPoluTekstowym: !lap })
      bufor.current = lap ? k.bufor : PUSTY_BUFOR
      if (k.skan !== null) {
        e.preventDefault()
        e.stopPropagation()
        skan.current(k.skan)
      }
    }
    const onPaste = (e: ClipboardEvent) => {
      if (!wklej.current) return
      const d = decyzjaWklejenia(opis(e.target, poleSzukania), dialogOtwarty())
      if (d === 'pomin') return
      const tekst = e.clipboardData?.getData('text/plain') ?? ''
      if (!tekst.trim()) return
      wklej.current(tekst, d)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('paste', onPaste, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('paste', onPaste, true)
    }
  }, [poleSzukania])
  return null
}
