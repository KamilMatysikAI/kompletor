// Pomoc → jeden dokument z docs/. Slug szukany wyłącznie na liście plików z katalogu (lib/pomoc/dokumenty.ts):
// spoza listy, w tym każda próba ścieżki, daje 404. HTML powstaje z markdownu bez surowego HTML i z filtrem linków.
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getDoc, listDocs } from '@/lib/pomoc/dokumenty'
import { requireSession } from '@/lib/panel/kontekst'

type Props = { params: Promise<{ temat: string }> }

export async function generateMetadata({ params }: Props) {
  const { temat } = await params
  const doc = listDocs().find((d) => d.slug === temat)
  return { title: doc ? `${doc.title} · Pomoc` : 'Pomoc' }
}

export default async function TematPomocy({ params }: Props) {
  await requireSession()
  const { temat } = await params
  const doc = getDoc(temat)
  if (!doc) notFound()
  return (
    <>
      <header className="page-head">
        <div>
          <h1>{doc.title}</h1>
        </div>
      </header>
      <article className="card pomoc-tresc" dangerouslySetInnerHTML={{ __html: doc.html }} />
    </>
  )
}
