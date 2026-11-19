import { redirect } from 'next/navigation'

// Start panelu: pulpit (bez sesji proxy i requireSession odsyłają na /logowanie).
export default function Home(): never {
  redirect('/pulpit')
}
