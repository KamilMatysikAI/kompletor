// docker/kontrola-migracji-bazowej.sql na prawdziwym Postgresie: każdy przypadek we własnym schemacie (search_path),
// w transakcji wycofywanej na końcu, więc baza testów zostaje nietknięta.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testDbUrl } from './global-setup'

const SQL = readFileSync(path.resolve(__dirname, '..', 'docker', 'kontrola-migracji-bazowej.sql'), 'utf8')

let client: pg.Client

beforeAll(async () => {
  client = new pg.Client({ connectionString: testDbUrl() })
  await client.connect()
})

afterAll(async () => {
  await client.end()
})

/** Zakłada schemat z opcjonalną tabelą migracji i wierszami, uruchamia kontrolę; zwraca treść błędu albo null. */
async function sprawdz(wiersze: { nazwa: string; wykonana: boolean }[] | null): Promise<string | null> {
  await client.query('BEGIN')
  try {
    await client.query('CREATE SCHEMA kontrola_bazowej')
    await client.query('SET LOCAL search_path TO kontrola_bazowej')
    if (wiersze) {
      await client.query(
        'CREATE TABLE _prisma_migrations (id varchar(36) PRIMARY KEY, migration_name varchar(255) NOT NULL, finished_at timestamptz, started_at timestamptz NOT NULL DEFAULT now())',
      )
      for (const [i, w] of wiersze.entries())
        await client.query('INSERT INTO _prisma_migrations (id, migration_name, finished_at) VALUES ($1, $2, $3)', [String(i), w.nazwa, w.wykonana ? new Date() : null])
    }
    try {
      await client.query(SQL)
      return null
    } catch (e) {
      return (e as Error).message
    }
  } finally {
    await client.query('ROLLBACK')
  }
}

describe('kontrola migracji bazowej (SQL)', () => {
  it('pusta baza bez tabeli migracji przechodzi', async () => {
    expect(await sprawdz(null)).toBeNull()
  })

  it('tabela migracji bez wierszy przechodzi', async () => {
    expect(await sprawdz([])).toBeNull()
  })

  it('baza założona na migracji bazowej (z nowszymi po niej) przechodzi', async () => {
    expect(await sprawdz([{ nazwa: '00000000000000_baza', wykonana: true }, { nazwa: '20270101000000_nowa', wykonana: true }])).toBeNull()
  })

  it('starsza historia bez migracji bazowej zatrzymuje start', async () => {
    expect(await sprawdz([{ nazwa: '20260101000000_stara', wykonana: true }])).toContain('KOMPLETOR_BRAK_MIGRACJI_BAZOWEJ')
  })

  it('migracja bazowa nieudana (bez finished_at) przy starszej historii też zatrzymuje', async () => {
    expect(await sprawdz([{ nazwa: '20260101000000_stara', wykonana: true }, { nazwa: '00000000000000_baza', wykonana: false }])).toContain('KOMPLETOR_BRAK_MIGRACJI_BAZOWEJ')
  })

  it('starsza historia po oznaczeniu migracji bazowej jako wykonanej przechodzi', async () => {
    expect(await sprawdz([{ nazwa: '20260101000000_stara', wykonana: true }, { nazwa: '00000000000000_baza', wykonana: true }])).toBeNull()
  })
})
