// Pola formularza konta z manifestu adaptera (na komponentach app/ui): etykieta po ludzku,
// opis z manifestu jako podpowiedź pod polem. Sekret to pole hasła bez wartości: przy edycji „zapisany dnia X,
// wklej nowy, żeby zmienić”.
import type { ConfigField, SecretField } from '@/lib/adaptery/kontrakt'
import { etykietaPola } from '@/lib/kanaly/platformy'
import { PoleHasla, PoleTekstowe, Wybor } from '@/app/ui'

const dayFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'numeric', year: 'numeric' })

const zDuzej = (d: string) => d.charAt(0).toUpperCase() + d.slice(1)

export function PoleUstawieniaWejscie({ field, value }: { field: ConfigField; value: string }) {
  const id = `c-${field.key}`
  const wspolne = { id, name: field.key, etykieta: etykietaPola(field.key), pomoc: zDuzej(field.description), opcjonalne: !field.required, defaultValue: value }
  if (field.type === 'boolean')
    return (
      <Wybor
        {...wspolne}
        opcje={[
          { wartosc: '', etykieta: '(domyślnie)' },
          { wartosc: 'true', etykieta: 'tak' },
          { wartosc: 'false', etykieta: 'nie' },
        ]}
      />
    )
  if (field.options)
    return <Wybor {...wspolne} opcje={[...(field.required ? [] : [{ wartosc: '', etykieta: '(domyślnie)' }]), ...field.options.map((o) => ({ wartosc: o.value, etykieta: o.label }))]} />
  return (
    <PoleTekstowe
      {...wspolne}
      required={field.required}
      inputMode={field.type === 'number' ? 'numeric' : /url$/i.test(field.key) ? 'url' : undefined}
      placeholder={/url$/i.test(field.key) ? 'https://' : undefined}
      maxLength={500}
    />
  )
}

export function PoleSekretuWejscie({ field, savedAt }: { field: SecretField; savedAt: Date | null }) {
  const nazwa = zDuzej(field.description.split(' (')[0]!)
  return (
    <PoleHasla
      id={`s-${field.name}`}
      name={field.name}
      etykieta={nazwa}
      opcjonalne={!field.required}
      autoComplete="new-password"
      spellCheck={false}
      maxLength={8192}
      pomoc={savedAt ? `Zapisany ${dayFmt.format(savedAt)}. Wklej nowy, żeby zmienić; puste pole zostawia obecny.` : field.required ? 'Wklej klucz.' : undefined}
    />
  )
}
