// przycisk panelu. Wygląd = dotychczasowe klasy `.btn` (te same ekrany przed i po przepięciu), API
// semantyczne: wariant mówi o roli przycisku, nie o kolorze. Bez hooków, działa w komponentach serwerowych.
import Link from 'next/link'
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'

export type WariantPrzycisku = 'glowny' | 'drugorzedny' | 'cichy' | 'niebezpieczny'
export type RozmiarPrzycisku = 'sm' | 'md' | 'lg' | 'xl'

const WARIANT: Record<WariantPrzycisku, string> = { glowny: 'primary', drugorzedny: '', cichy: 'ghost', niebezpieczny: 'danger' }
const ROZMIAR: Record<RozmiarPrzycisku, string> = { sm: 'small', md: '', lg: 'ui-lg', xl: 'xl' }

/**
 * klasa pozycji menu akcji (`MenuAkcji`, menu.tsx): pełna szerokość, 44 px celu. Stała tutaj, nie w menu.tsx,
 * bo plik z 'use client' w komponencie serwerowym daje zamiast wartości odwołanie do klienta.
 */
export const POZYCJA_MENU = 'ui-menu-poz'

export function klasyPrzycisku(wariant: WariantPrzycisku = 'drugorzedny', rozmiar: RozmiarPrzycisku = 'md', dodatkowe?: string): string {
  return ['btn', WARIANT[wariant], ROZMIAR[rozmiar], dodatkowe].filter(Boolean).join(' ')
}

type Wspolne = {
  wariant?: WariantPrzycisku
  rozmiar?: RozmiarPrzycisku
  /** szerokość 100% (np. na telefonie albo w modalu) */
  pelny?: boolean
  children: ReactNode
}

export type PrzyciskProps = Wspolne &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
    ref?: Ref<HTMLButtonElement>
    /** kręciołek i `aria-busy`; przycisk nieaktywny */
    ladowanie?: boolean
    /**
     * Przycisk widoczny, ale nieaktywny, z powodem (tooltip i opis dla czytnika ekranu). Zasada fal: funkcja za
     * wyłącznikiem jest widoczna i mówi, czemu nie działa, zamiast znikać.
     */
    powodWylaczenia?: string | null
  }

export function Przycisk({ wariant, rozmiar, pelny, ladowanie, powodWylaczenia, className, type = 'button', disabled, children, onClick, ...rest }: PrzyciskProps) {
  const klasy = klasyPrzycisku(wariant, rozmiar, [pelny ? 'ui-pelny' : '', className].filter(Boolean).join(' '))
  if (powodWylaczenia) {
    // aria-disabled zamiast disabled: przycisk zostaje w kolejności Tab, więc powód da się przeczytać i zobaczyć
    return (
      <button {...rest} type="button" className={`${klasy} is-disabled`} aria-disabled="true" title={powodWylaczenia} data-powod={powodWylaczenia}>
        {children}
        <span className="sr"> ({powodWylaczenia})</span>
      </button>
    )
  }
  return (
    <button {...rest} onClick={onClick} type={type} className={klasy} disabled={disabled || ladowanie} aria-busy={ladowanie || undefined}>
      {ladowanie && <span className="ui-kreciol" aria-hidden="true" />}
      {children}
    </button>
  )
}

export function PrzyciskLink({ href, wariant, rozmiar, pelny, className, children, ...rest }: Wspolne & { href: string; className?: string; title?: string; target?: string; rel?: string; prefetch?: boolean; scroll?: boolean; 'aria-label'?: string }) {
  return (
    <Link href={href} className={klasyPrzycisku(wariant, rozmiar, [pelny ? 'ui-pelny' : '', className].filter(Boolean).join(' '))} {...rest}>
      {children}
    </Link>
  )
}
