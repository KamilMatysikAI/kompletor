// Kreator pierwszego uruchomienia. Poza panelem jak /logowanie: dostępny tylko na świeżej instalacji
// self-host (zero kont) z kodem instalacji; w każdym innym przypadku przekierowanie na /logowanie. Logika i zasady:
// lib/instalacja/kreator.ts.
import { redirect } from 'next/navigation'
import { stanKreatora } from '@/lib/instalacja/kreator'
import { FormularzStartu } from './formularz'
import { SZABLONY } from '@/lib/automaty/szablony'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Pierwsze uruchomienie' }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

export default async function Start({ searchParams }: Props) {
  const stan = await stanKreatora()
  if (!stan.dostepny) redirect('/logowanie')
  const sp = await searchParams
  const kod = typeof sp['kod'] === 'string' ? sp['kod'].slice(0, 200) : ''
  return (
    <main className="login">
      <div className="login-box">
        <div className="brand login-brand">
          <b>Kompletor</b>
          <span>zamówienia i wysyłki</span>
        </div>
        <h1>Pierwsze uruchomienie</h1>
        <p className="muted small">
          {stan.istniejacaFirma
            ? `Firma „${stan.istniejacaFirma}” jest już w bazie. Załóż jej pierwsze konto właściciela.`
            : 'Załóż swoją firmę i konto właściciela. Możesz też najpierw obejrzeć firmę demo z danymi fikcyjnymi.'}
        </p>
        {stan.wieleFirm ? (
          <div className="banner amber" role="status">
            <div>W bazie jest kilka firm bez kont. Pierwsze konto załóż poleceniem w kontenerze: node dist/uzytkownik.cjs dodaj (opis w README).</div>
          </div>
        ) : (
          <FormularzStartu kod={kod} pytajONazwe={!stan.istniejacaFirma} szablony={SZABLONY.map((s) => ({ id: s.id, nazwa: s.nazwa, dlaKogo: s.dlaKogo }))} />
        )}
      </div>
      <p className="login-foot small muted">Kod instalacji jest w logu kontenera web, w adresie wypisanym po pierwszym starcie.</p>
    </main>
  )
}
