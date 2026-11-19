// adapter skrzynki na imapflow z podmienioną biblioteką (bez sieci): wywołania IMAP, odrzucony login,
// brak folderu, przeniesienie z zapasem „tylko przeczytany”, hosting tylko z publicznym adresem.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  opcje: [] as Record<string, unknown>[],
  klient: null as null | (Record<'on' | 'connect' | 'close' | 'logout' | 'mailboxOpen' | 'search' | 'fetchAll' | 'fetchOne' | 'messageFlagsAdd' | 'mailboxCreate' | 'messageMove' | 'list', ReturnType<typeof vi.fn>> & { usable: boolean }),
  lookup: vi.fn(async (_host: string) => ({ address: '93.184.216.34', family: 4 })),
}))

vi.mock('node:dns/promises', () => ({ lookup: h.lookup, default: { lookup: h.lookup } }))
vi.mock('imapflow', () => ({
  ImapFlow: vi.fn(function (this: unknown, opcje: Record<string, unknown>) {
    h.opcje.push(opcje)
    return h.klient
  }),
}))

import { BladLogowaniaImap, BladPolaczeniaImap, otworzSkrzynkeImap, sprawdzKonfiguracjeImap, type KonfiguracjaImap } from './imap'

const CFG: KonfiguracjaImap = { host: 'imap.example.com', port: 993, bezpieczenstwo: 'TLS', login: 'odbicia@example.com', haslo: 'tajne-haslo-imap' }

beforeEach(() => {
  h.opcje.length = 0
  h.lookup.mockClear()
  h.klient = {
    usable: true,
    list: vi.fn(async () => [
      { path: 'INBOX', delimiter: '/' },
      { path: 'Kompletor/odbicia', delimiter: '/' },
    ]),
    on: vi.fn(),
    connect: vi.fn(async () => {}),
    close: vi.fn(),
    logout: vi.fn(async () => {}),
    mailboxOpen: vi.fn(async () => ({ uidValidity: BigInt(1700000000) })),
    search: vi.fn(async () => [7, 3, 9]),
    fetchAll: vi.fn(async () => [
      { uid: 9, size: 900 },
      { uid: 7, size: 700 },
    ]),
    fetchOne: vi.fn(async () => ({ uid: 7, source: Buffer.from('raport') })),
    messageFlagsAdd: vi.fn(async () => true),
    mailboxCreate: vi.fn(async () => ({ path: 'Kompletor.odbicia', created: true })),
    messageMove: vi.fn(async () => ({ path: 'INBOX', destination: 'Kompletor.odbicia' })),
  }
})

describe('otworzSkrzynkeImap', () => {
  it('nieprzeczytane od kursora rosnąco; treść przez fetchOne(source); odłożenie = \\Seen + folder Kompletor/odbicia', async () => {
    const s = await otworzSkrzynkeImap()(CFG, 'INBOX')
    expect(h.opcje[0]).toMatchObject({ host: 'imap.example.com', port: 993, secure: true, auth: { user: CFG.login, pass: CFG.haslo }, logger: false })
    expect(s.uidValidity).toBe('1700000000')
    expect(await s.nieprzeczytane(5, 2)).toEqual([
      { uid: 7, rozmiar: 700 },
      { uid: 9, rozmiar: 900 },
    ])
    expect(h.klient!.search).toHaveBeenCalledWith({ seen: false, uid: '6:*' }, { uid: true })
    expect(h.klient!.fetchAll).toHaveBeenCalledWith('7,9', { uid: true, size: true }, { uid: true })
    expect((await s.pobierz(7))?.toString()).toBe('raport')
    expect(h.klient!.fetchOne).toHaveBeenCalledWith('7', { uid: true, source: true }, { uid: true })
    expect(await s.odloz(7)).toBe('PRZENIESIONY')
    expect(await s.odloz(9)).toBe('PRZENIESIONY')
    expect(h.klient!.messageFlagsAdd).toHaveBeenCalledWith('7', ['\\Seen'], { uid: true })
    expect(h.klient!.mailboxCreate).toHaveBeenCalledTimes(1) // ścieżka folderu zapamiętana
    expect(h.klient!.mailboxCreate).toHaveBeenCalledWith(['Kompletor', 'odbicia'])
    expect(h.klient!.messageMove).toHaveBeenCalledWith('9', 'Kompletor.odbicia', { uid: true })
    await s.zamknij()
    expect(h.klient!.logout).toHaveBeenCalled()
  })

  it('kursor powyżej ostatniego maila: serwer i tak zwraca ostatni, adapter go odfiltrowuje', async () => {
    h.klient!.search.mockResolvedValueOnce([4])
    const s = await otworzSkrzynkeImap()(CFG, 'INBOX')
    expect(await s.nieprzeczytane(10, 50)).toEqual([])
    expect(h.klient!.fetchAll).not.toHaveBeenCalled()
  })

  it('nieudane przeniesienie: mail zostaje przeczytany w folderze, bez wyjątku', async () => {
    h.klient!.messageMove.mockRejectedValueOnce(new Error('NO [CANNOT] nie wolno'))
    const s = await otworzSkrzynkeImap()(CFG, 'INBOX')
    expect(await s.odloz(7)).toBe('PRZECZYTANY')
    expect(h.klient!.messageFlagsAdd).toHaveBeenCalled()
  })

  it('odrzucony login = BladLogowaniaImap bez hasła w komunikacie', async () => {
    h.klient!.connect.mockRejectedValueOnce(Object.assign(new Error('Authentication failed for tajne-haslo-imap'), { authenticationFailed: true }))
    const e = await otworzSkrzynkeImap()(CFG, 'INBOX').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(BladLogowaniaImap)
    expect(String((e as Error).message)).not.toContain('tajne-haslo-imap')
    expect(h.klient!.close).toHaveBeenCalled()
  })

  it('brak folderu = czytelny błąd i wylogowanie', async () => {
    h.klient!.mailboxOpen.mockRejectedValueOnce(Object.assign(new Error('Command failed'), { serverResponseCode: 'NONEXISTENT' }))
    await expect(otworzSkrzynkeImap()(CFG, 'Odbicia')).rejects.toThrow(/nie ma folderu „Odbicia”/)
    expect(h.klient!.logout).toHaveBeenCalled()
  })

  it('hosting: łączy się ze sprawdzonym adresem publicznym (nazwa do certyfikatu), prywatny adres = odmowa bez połączenia', async () => {
    await otworzSkrzynkeImap({ tylkoPubliczne: true })(CFG, 'INBOX')
    expect(h.opcje[0]).toMatchObject({ host: '93.184.216.34', servername: 'imap.example.com' })
    h.lookup.mockResolvedValueOnce({ address: '10.0.0.5', family: 4 })
    await expect(otworzSkrzynkeImap({ tylkoPubliczne: true })(CFG, 'INBOX')).rejects.toThrow(/lokalny albo prywatny/)
    expect(h.opcje).toHaveLength(1)
  })

  it('STARTTLS wymusza szyfrowanie, BRAK go wyłącza', async () => {
    await otworzSkrzynkeImap()({ ...CFG, port: 143, bezpieczenstwo: 'STARTTLS' }, 'INBOX')
    await otworzSkrzynkeImap()({ ...CFG, port: 143, bezpieczenstwo: 'BRAK' }, 'INBOX')
    expect(h.opcje[0]).toMatchObject({ secure: false, doSTARTTLS: true })
    expect(h.opcje[1]).toMatchObject({ secure: false, doSTARTTLS: false })
  })
  it('serwer odmawia CREATE bez kodu ALREADYEXISTS: ścieżka folderu z listy, zapamiętana', async () => {
    h.klient!.mailboxCreate.mockRejectedValue(new Error('NO Mailbox already exists'))
    h.klient!.list.mockResolvedValue([
      { path: 'INBOX', delimiter: '.' },
      { path: 'INBOX.Kompletor.odbicia', delimiter: '.' },
      { path: 'Kompletor.odbicia', delimiter: '.' },
    ])
    const s = await otworzSkrzynkeImap()(CFG, 'INBOX')
    expect(await s.odloz(7)).toBe('PRZENIESIONY')
    expect(await s.odloz(9)).toBe('PRZENIESIONY')
    expect(h.klient!.messageMove).toHaveBeenCalledWith('9', 'Kompletor.odbicia', { uid: true })
    expect(h.klient!.mailboxCreate).toHaveBeenCalledTimes(1)
    expect(h.klient!.list).toHaveBeenCalledTimes(1)
  })

  it('serwer z przedrostkiem INBOX. — folder dopasowany po końcówce ścieżki', async () => {
    h.klient!.mailboxCreate.mockRejectedValue(new Error('NO Mailbox already exists'))
    h.klient!.list.mockResolvedValue([
      { path: 'INBOX', delimiter: '.' },
      { path: 'INBOX.Kompletor', delimiter: '.' },
      { path: 'INBOX.Inne.odbicia', delimiter: '.' },
      { path: 'INBOX.Kompletor.odbicia', delimiter: '.' },
    ])
    const s = await otworzSkrzynkeImap()(CFG, 'INBOX')
    expect(await s.odloz(7)).toBe('PRZENIESIONY')
    expect(h.klient!.messageMove).toHaveBeenCalledWith('7', 'INBOX.Kompletor.odbicia', { uid: true })
  })

  it('folderu nie ma na liście: raport zostaje przeczytany, bez ponawiania CREATE przy każdym raporcie', async () => {
    h.klient!.mailboxCreate.mockRejectedValue(new Error('NO [CANNOT] nie wolno'))
    h.klient!.list.mockResolvedValue([{ path: 'INBOX', delimiter: '/' }])
    const s = await otworzSkrzynkeImap()(CFG, 'INBOX')
    expect(await s.odloz(7)).toBe('PRZECZYTANY')
    expect(await s.odloz(9)).toBe('PRZECZYTANY')
    expect(h.klient!.mailboxCreate).toHaveBeenCalledTimes(1)
    expect(h.klient!.messageMove).not.toHaveBeenCalled()
  })

  it('błąd przy zerwanym połączeniu = BladPolaczeniaImap (pobranie, lista, przeniesienie); przy żywym połączeniu zwykły błąd', async () => {
    const s = await otworzSkrzynkeImap()(CFG, 'INBOX')
    h.klient!.fetchOne.mockRejectedValueOnce(new Error('NO [SERVERBUG] fetch'))
    await expect(s.pobierz(7)).rejects.not.toBeInstanceOf(BladPolaczeniaImap)
    h.klient!.usable = false
    h.klient!.fetchOne.mockRejectedValueOnce(new Error('Connection not available'))
    await expect(s.pobierz(7)).rejects.toBeInstanceOf(BladPolaczeniaImap)
    h.klient!.search.mockRejectedValueOnce(new Error('Socket closed'))
    await expect(s.nieprzeczytane(0, 5)).rejects.toBeInstanceOf(BladPolaczeniaImap)
    h.klient!.messageFlagsAdd.mockRejectedValueOnce(new Error('Socket closed'))
    await expect(s.odloz(7)).rejects.toBeInstanceOf(BladPolaczeniaImap)
    h.klient!.messageMove.mockRejectedValueOnce(new Error('Socket closed'))
    await expect(s.odloz(7)).rejects.toBeInstanceOf(BladPolaczeniaImap)
  })

  it('wstrzymanie przy pustym kodzie, AUTHENTICATIONFAILED, AUTHORIZATIONFAILED albo EXPIRED; chwilowa odmowa = błąd do ponowienia', async () => {
    // AUTHORIZATIONFAILED i EXPIRED też wstrzymują czytanie
    for (const kod of ['AUTHENTICATIONFAILED', 'AUTHORIZATIONFAILED', 'EXPIRED', 'expired']) {
      h.klient!.connect.mockRejectedValueOnce(Object.assign(new Error('Authentication failed'), { authenticationFailed: true, serverResponseCode: kod }))
      await expect(otworzSkrzynkeImap()(CFG, 'INBOX'), kod).rejects.toBeInstanceOf(BladLogowaniaImap)
    }
    for (const kod of ['UNAVAILABLE', 'CONTACTADMIN', 'LIMIT']) {
      h.klient!.connect.mockRejectedValueOnce(Object.assign(new Error('Authentication failed'), { authenticationFailed: true, serverResponseCode: kod }))
      const e = await otworzSkrzynkeImap()(CFG, 'INBOX').catch((x: unknown) => x)
      expect(e, kod).toBeInstanceOf(Error)
      expect(e, kod).not.toBeInstanceOf(BladLogowaniaImap)
      expect(String((e as Error).message)).toMatch(/połączenie z serwerem IMAP/)
    }
  })

  it('hosting odrzuca literał IPv6 pętli zwrotnej w zapisie niekanonicznym (bez połączenia)', async () => {
    for (const host of ['0:0:0:0:0:0:0:1', '::0001', '0:0:0:0:0:ffff:7f00:1', '2002:7f00:1::1', 'fec0::1']) {
      await expect(otworzSkrzynkeImap({ tylkoPubliczne: true })({ ...CFG, host }, 'INBOX'), host).rejects.toThrow(/lokalny albo prywatny/)
      expect(sprawdzKonfiguracjeImap({ host, port: 993, bezpieczenstwo: 'TLS', folder: 'INBOX' }, { hosting: true }).join(' '), host).toMatch(/dostępny z internetu/)
    }
    h.lookup.mockResolvedValueOnce({ address: '0:0:0:0:0:ffff:a00:5', family: 6 })
    await expect(otworzSkrzynkeImap({ tylkoPubliczne: true })(CFG, 'INBOX')).rejects.toThrow(/lokalny albo prywatny/)
    expect(h.opcje).toHaveLength(0)
  })
})
