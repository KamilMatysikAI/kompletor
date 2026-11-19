'use client'
// okno modalne na natywnym <dialog> (showModal: fokus w środku, Esc zamyka, tło nieaktywne dla
// czytników) i potwierdzenie zamiast `window.confirm` (którego nie da się ostylować ani przetłumaczyć przycisków).
// `PrzyciskPotwierdz` to przycisk wysyłający formularz dopiero po „Tak” w oknie potwierdzenia.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Przycisk, type PrzyciskProps, type WariantPrzycisku } from './przycisk'

/** Element oznaczony `data-fokus` dostaje fokus po otwarciu okna (np. bezpieczna odpowiedź w `Potwierdzenie`). */
export function fokusPoOtwarciu(d: ParentNode): void {
  d.querySelector<HTMLElement>('[data-fokus]')?.focus()
}

export function Modal({ otwarty, onZamknij, tytul, children, stopka, szeroki }: { otwarty: boolean; onZamknij: () => void; tytul: ReactNode; children?: ReactNode; stopka?: ReactNode; szeroki?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (otwarty && !d.open) {
      d.showModal()
      // `autoFocus` w zawsze zamontowanym <dialog> działa tylko po SSR; fokus ustawiamy jawnie po
      // showModal(), inaczej trafia na „×” i Enter zamyka okno zamiast odpowiedzieć
      fokusPoOtwarciu(d)
    }
    if (!otwarty && d.open) d.close()
  }, [otwarty])
  return (
    <dialog
      ref={ref}
      className={`ui-modal${szeroki ? ' ui-modal-szeroki' : ''}`}
      aria-labelledby={`${id}-t`}
      onClose={onZamknij}
      onCancel={(e) => {
        e.preventDefault()
        onZamknij()
      }}
      onClick={(e) => {
        if (e.target === ref.current) onZamknij() // klik w tło
      }}
    >
      <div className="ui-modal-pudlo">
        <div className="ui-modal-glowa">
          <h2 id={`${id}-t`}>{tytul}</h2>
          <button type="button" className="ui-modal-x" aria-label="Zamknij" onClick={onZamknij}>
            ×
          </button>
        </div>
        {children && <div className="ui-modal-tresc">{children}</div>}
        {stopka && <div className="ui-modal-stopka">{stopka}</div>}
      </div>
    </dialog>
  )
}

export function Potwierdzenie({
  otwarte,
  tytul,
  children,
  tak = 'Tak',
  nie = 'Anuluj',
  wariant = 'glowny',
  onTak,
  onNie,
}: {
  otwarte: boolean
  tytul: ReactNode
  children?: ReactNode
  tak?: string
  nie?: string
  wariant?: WariantPrzycisku
  onTak: () => void
  onNie: () => void
}) {
  return (
    <Modal
      otwarty={otwarte}
      onZamknij={onNie}
      tytul={tytul}
      stopka={
        <>
          {/* przy wariancie niebezpiecznym fokus na „Anuluj”, żeby Enter niczego nie skasował */}
          <Przycisk onClick={onNie} data-fokus={wariant === 'niebezpieczny' ? '' : undefined}>
            {nie}
          </Przycisk>
          <Przycisk wariant={wariant} onClick={onTak} data-fokus={wariant === 'niebezpieczny' ? undefined : ''}>
            {tak}
          </Przycisk>
        </>
      }
    >
      {children}
    </Modal>
  )
}

/**
 * Przycisk w formularzu, który najpierw pyta. Po „Tak” wysyła swój formularz tym przyciskiem (`requestSubmit`),
 * więc `name`/`value` przycisku i `formAction` działają jak przy zwykłym kliknięciu.
 */
export function PrzyciskPotwierdz({
  pytanie,
  tytul = 'Na pewno?',
  tak,
  nie,
  wariantTak,
  pomin,
  ...przycisk
}: Omit<PrzyciskProps, 'type' | 'onClick'> & { pytanie: ReactNode; tytul?: ReactNode; tak?: string; /** napis przycisku rezygnacji (domyślnie „Anuluj”) */ nie?: string; wariantTak?: WariantPrzycisku; /** bez pytania (np. pierwszy token) */ pomin?: boolean }) {
  const [otwarte, setOtwarte] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <>
      <Przycisk
        {...przycisk}
        ref={ref}
        type="submit"
        onClick={(e) => {
          if (pomin) return
          e.preventDefault()
          setOtwarte(true)
        }}
      />
      <Potwierdzenie
        otwarte={otwarte}
        tytul={tytul}
        tak={tak ?? (typeof przycisk.children === 'string' ? przycisk.children : 'Tak')}
        {...(nie ? { nie } : {})}
        wariant={wariantTak ?? (przycisk.wariant === 'niebezpieczny' ? 'niebezpieczny' : 'glowny')}
        onNie={() => setOtwarte(false)}
        onTak={() => {
          setOtwarte(false)
          const b = ref.current
          if (!b?.form) return
          b.form.requestSubmit(b)
        }}
      >
        {typeof pytanie === 'string' ? <p>{pytanie}</p> : pytanie}
      </Potwierdzenie>
    </>
  )
}
