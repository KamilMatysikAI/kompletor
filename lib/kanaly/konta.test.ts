// kod konta w adresie i pola sekretów w formularzu. Bez bazy.
import { describe, expect, it } from 'vitest'
import { ALLEGRO_MANIFEST } from '../adaptery/allegro'
import { kodKonta, parseKodKonta, polaSekretow } from './konta'

describe('kod konta w adresie', () => {
  it('zły zapis „%” = null (404), nie wyjątek; poprawny kod wraca w obie strony', () => {
    expect(parseKodKonta('WOO.%zz')).toBeNull()
    expect(parseKodKonta('WOO.%E0%A4%A')).toBeNull()
    expect(parseKodKonta('NIEZNANY.sklep-1')).toBeNull()
    expect(parseKodKonta(kodKonta({ channel: 'WOO', channelAccountId: 'sklep-1' }))).toEqual({ channel: 'WOO', channelAccountId: 'sklep-1' })
    expect(parseKodKonta('ALLEGRO.konto%2D2')).toEqual({ channel: 'ALLEGRO', channelAccountId: 'konto-2' })
  })
})

describe('pola sekretów do wklejenia', () => {
  it('Allegro: Client ID i Secret tak, tokeny z autoryzacji i pola zapisywane przez adapter nie', () => {
    const names = polaSekretow(ALLEGRO_MANIFEST).map((s) => s.name)
    expect(names).toContain('ALLEGRO_CLIENT_ID')
    expect(names).toContain('ALLEGRO_CLIENT_SECRET')
    expect(names).not.toContain('ALLEGRO_ACCESS_TOKEN')
    expect(names).not.toContain('ALLEGRO_REFRESH_TOKEN')
    expect(names).toHaveLength(2)
  })
})
