// Układ maila: HTML dla klientów pocztowych i wersja tekstowa z tej samej treści (TrescGotowa).
// HTML: tabele, style inline, 600 px (na telefonie 100%), czcionki systemowe, bez zewnętrznych zasobów poza
// logo sklepu. Tryb ciemny: logo na własnej białej „plakietce”, więc ciemne logo nie znika, gdy klient
// przyciemnia tło; opcjonalne logoCiemneUrl podmienia je tam, gdzie działa prefers-color-scheme.
// Blok <style> w <head> to tylko ulepszenie (telefon, tryb ciemny); bez niego mail wygląda poprawnie.
import { BladSzablonu, escapeHtml, kolorTekstuNa, kontrastZBialym, poprawnyEmail, sprawdzUrl } from './formaty'
import type { BlokGotowy, TrescGotowa } from './silnik'
import { type DaneSklepu, type KontekstMarki, LOGO_FIRMY_SRC, type Odbiorca } from './typy'

const CZCIONKA = 'Arial, Helvetica, sans-serif'
const KOLOR_TEKSTU = '#27272a'
const KOLOR_SZARY = '#71717a'
const TLO = '#f4f4f5'
// Po tekście podglądu: klient pocztowy nie dokleja do podglądu dalszej treści maila (nazwa sklepu, nagłówek).
const WYPELNIACZ_PODGLADU = '&zwnj;&nbsp;'.repeat(60)

/** Sprawdza dane marki, które trafiają do atrybutów HTML i nagłówków (kolor, adresy). Rzuca BladSzablonu. */
export function sprawdzMarke(k: KontekstMarki): void {
  const bledy: string[] = []
  const { sklep, firma } = k
  if (!sklep?.nazwa?.trim()) bledy.push('sklep: brak nazwy')
  if (!firma?.nazwa?.trim()) bledy.push('firma: brak nazwy')
  if (!/^#[0-9a-fA-F]{6}$/.test(sklep?.kolorGlowny ?? '')) bledy.push(`sklep: kolor główny musi mieć postać #rrggbb, jest „${sklep?.kolorGlowny}”`)
  if (!poprawnyEmail(sklep?.odpowiedzDo ?? '')) bledy.push(`sklep: niepoprawny adres do odpowiedzi „${sklep?.odpowiedzDo}”`)
  for (const [pole, url] of [
    ['logo', sklep?.logoUrl],
    ['logo ciemne', sklep?.logoCiemneUrl],
    ['strona sklepu', sklep?.www],
    ['strona firmy', firma?.www],
  ] as const) {
    if (!url) continue
    if (pole === 'logo' && url === LOGO_FIRMY_SRC) continue // logo firmy osadzone w mailu
    try {
      sprawdzUrl(url, `sklep: ${pole}`)
    } catch (e) {
      bledy.push(...(e as BladSzablonu).bledy)
    }
  }
  const szerLogo = szerokoscLogo(sklep)
  if (szerLogo != null && !(Number.isFinite(szerLogo) && szerLogo > 0))
    bledy.push(`sklep: szerokość logo musi być dodatnią liczbą, jest „${sklep.logoSzerokosc}”`)
  if (sklep?.logoCiemneUrl && !sklep.logoUrl) bledy.push('sklep: logo w wersji ciemnej wymaga zwykłego logo')
  if (firma?.email && !poprawnyEmail(firma.email)) bledy.push(`firma: niepoprawny e-mail „${firma.email}”`)
  if (firma?.emailBiura && !poprawnyEmail(firma.emailBiura)) bledy.push(`firma: niepoprawny e-mail biura „${firma.emailBiura}”`)
  if (bledy.length) throw new BladSzablonu(bledy)
}

/** Szerokość logo jako liczba: z bazy lub formularza nadpisań może przyjść tekst („200”); pusty = brak. */
function szerokoscLogo(s: DaneSklepu | undefined): number | null {
  const w = s?.logoSzerokosc
  if (w == null || (typeof w === 'string' && !w.trim())) return null
  return Number(w)
}

function e(s: string): string {
  return escapeHtml(s)
}

function zLiniami(s: string): string {
  return e(s).replace(/\r?\n/g, '<br>')
}

function wiersz(tresc: string, gora = 16): string {
  return `<tr><td class="pad" style="padding:${gora}px 32px 0 32px;">${tresc}</td></tr>`
}

function blokHtml(b: BlokGotowy, kolor: string, kolorLinku: string): string {
  const p = `margin:0;font-family:${CZCIONKA};font-size:16px;line-height:24px;color:${KOLOR_TEKSTU};`
  switch (b.typ) {
    case 'akapit':
      return wiersz(`<p style="${p}">${zLiniami(b.tekst)}</p>`)
    case 'uwaga':
      return wiersz(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
          `<td style="border-left:4px solid ${kolor};background-color:#fafafa;padding:12px 16px;">` +
          `<p style="${p}">${zLiniami(b.tekst)}</p></td></tr></table>`,
      )
    case 'kod':
      return wiersz(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
          `<td style="background-color:${TLO};border:1px solid #e4e4e7;padding:12px 16px;font-family:Consolas, 'Courier New', monospace;` +
          `font-size:13px;line-height:20px;color:${KOLOR_TEKSTU};white-space:pre-wrap;word-break:break-word;">${zLiniami(b.tekst)}</td>` +
          `</tr></table>`,
      )
    case 'szczegoly': {
      const wiersze = b.wiersze
        .map(
          (w) =>
            `<tr><td style="padding:8px 12px 8px 0;border-bottom:1px solid #e4e4e7;font-family:${CZCIONKA};font-size:14px;line-height:20px;color:${KOLOR_SZARY};">${e(w.etykieta)}</td>` +
            `<td align="right" style="padding:8px 0;border-bottom:1px solid #e4e4e7;font-family:${CZCIONKA};font-size:15px;line-height:20px;color:${KOLOR_TEKSTU};font-weight:bold;">${zLiniami(w.wartosc)}</td></tr>`,
        )
        .join('')
      return wiersz(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${wiersze}</table>`)
    }
    case 'lista': {
      const naglowek = b.naglowek
        ? `<p style="margin:0 0 6px 0;font-family:${CZCIONKA};font-size:14px;line-height:20px;color:${KOLOR_SZARY};">${e(b.naglowek)}</p>`
        : ''
      const elementy = b.elementy
        .map((x) => `<tr><td style="padding:2px 0;font-family:${CZCIONKA};font-size:16px;line-height:24px;color:${KOLOR_TEKSTU};">${zLiniami(x)}</td></tr>`)
        .join('')
      return wiersz(`${naglowek}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${elementy}</table>`)
    }
    case 'przycisk': {
      const href = e(b.url)
      return wiersz(
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
          `<td align="center" bgcolor="${kolor}" style="border-radius:6px;background-color:${kolor};">` +
          `<a href="${href}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:${CZCIONKA};font-size:16px;line-height:20px;` +
          `font-weight:bold;color:${kolorTekstuNa(kolor)};text-decoration:none;border-radius:6px;">${e(b.etykieta)}</a></td></tr></table>` +
          `<p style="margin:8px 0 0 0;font-family:${CZCIONKA};font-size:13px;line-height:18px;color:${KOLOR_SZARY};">` +
          `Jeśli przycisk nie działa, skopiuj ten adres do przeglądarki: <a href="${href}" target="_blank" style="color:${kolorLinku};word-break:break-all;">${href}</a></p>`,
        20,
      )
    }
  }
}

function logoHtml(k: KontekstMarki, kolorLinku: string): string {
  const s = k.sklep
  if (!s.logoUrl) {
    return `<p style="margin:0;font-family:${CZCIONKA};font-size:20px;line-height:28px;font-weight:bold;color:${kolorLinku};">${e(s.nazwa)}</p>`
  }
  const szer = Math.min(400, Math.max(40, Math.round(szerokoscLogo(s) ?? 160)))
  const img = (src: string, klasa: string, styl = '') =>
    `<img class="${klasa}" src="${e(src)}" width="${szer}" alt="${e(s.nazwa)}" style="display:block;width:${szer}px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;font-family:${CZCIONKA};font-size:18px;font-weight:bold;color:${KOLOR_TEKSTU};${styl}">`
  // Wersja ciemna ukryta inline (także dla Outlooka: mso-hide), pokazuje ją tylko @media prefers-color-scheme.
  const ciemne = s.logoCiemneUrl
    ? `<!--[if !mso]><!-->${img(s.logoCiemneUrl, 'logo-ciemne', 'display:none;max-height:0;overflow:hidden;mso-hide:all;')}<!--<![endif]-->`
    : ''
  const klasa = s.logoCiemneUrl ? ' class="plakietka"' : ''
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td${klasa} bgcolor="#ffffff" style="background-color:#ffffff;padding:8px;border-radius:6px;">` +
    `${img(s.logoUrl, 'logo-jasne')}${ciemne}</td></tr></table>`
  )
}

function stopkaLinie(k: KontekstMarki, odbiorca: Odbiorca): string[] {
  const f = k.firma
  const linie = [f.nazwa, f.adres.filter(Boolean).join(', ')]
  if (f.nip) linie.push(`NIP ${f.nip}`)
  const kontakt = [f.email, f.telefon].filter((x): x is string => !!x)
  if (kontakt.length) linie.push(`Kontakt: ${kontakt.join(', ')}`)
  if (f.stopkaDodatkowa) linie.push(f.stopkaDodatkowa)
  linie.push(
    odbiorca === 'biuro'
      ? `Wiadomość wewnętrzna systemu Kompletor (firma: ${f.nazwa})`
      : `Ta wiadomość dotyczy zamówienia w sklepie ${k.sklep.nazwa}. Na pytania odpowiadamy pod adresem ${k.sklep.odpowiedzDo}.`,
  )
  return linie.filter((l) => l.trim() !== '')
}

export function ukladHtml(tresc: TrescGotowa, k: KontekstMarki, odbiorca: Odbiorca): string {
  const kolor = k.sklep.kolorGlowny.toLowerCase()
  // Jasny kolor marki (np. żółty) jako kolor linków na białym byłby nieczytelny: wtedy grafit.
  const kolorLinku = kontrastZBialym(kolor) >= 3 ? kolor : '#18181b'
  const znaczek =
    odbiorca === 'biuro'
      ? wiersz(
          `<span style="display:inline-block;padding:4px 10px;border-radius:4px;background-color:#fef3c7;font-family:${CZCIONKA};` +
            `font-size:12px;line-height:16px;font-weight:bold;color:#92400e;">WIADOMOŚĆ WEWNĘTRZNA</span>`,
          24,
        )
      : ''
  const stopka = stopkaLinie(k, odbiorca)
    .map((l) => `<p style="margin:0 0 4px 0;font-family:${CZCIONKA};font-size:12px;line-height:18px;color:${KOLOR_SZARY};">${e(l)}</p>`)
    .join('')
  const www = k.sklep.www
    ? `<p style="margin:8px 0 0 0;font-family:${CZCIONKA};font-size:12px;line-height:18px;"><a href="${e(k.sklep.www)}" target="_blank" style="color:${KOLOR_SZARY};">${e(k.sklep.www)}</a></p>`
    : ''
  return `<!DOCTYPE html>
<html lang="pl" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${e(tresc.temat)}</title>
<style>
@media only screen and (max-width: 620px) {
  .kontener { width: 100% !important; }
  .pad { padding-left: 20px !important; padding-right: 20px !important; }
}
@media (prefers-color-scheme: dark) {
  .logo-jasne { display: none !important; }
  .logo-ciemne { display: block !important; max-height: none !important; }
  .plakietka { background-color: transparent !important; }
}
</style>
</head>
<body style="margin:0;padding:0;width:100%;background-color:${TLO};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${e(tresc.podglad)}${WYPELNIACZ_PODGLADU}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${TLO}" style="background-color:${TLO};">
<tr><td align="center" style="padding:24px 8px;">
<table role="presentation" class="kontener" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:600px;max-width:600px;background-color:#ffffff;border-radius:8px;">
<tr><td height="6" bgcolor="${kolor}" style="height:6px;background-color:${kolor};font-size:0;line-height:0;border-radius:8px 8px 0 0;">&nbsp;</td></tr>
${znaczek}
${wiersz(logoHtml(k, kolorLinku), 24)}
${wiersz(`<h1 style="margin:0;font-family:${CZCIONKA};font-size:22px;line-height:30px;font-weight:bold;color:#18181b;">${e(tresc.naglowek)}</h1>`, 20)}
${tresc.bloki.map((b) => blokHtml(b, kolor, kolorLinku)).join('\n')}
<tr><td style="padding:32px 0 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>
</table>
<table role="presentation" class="kontener" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
<tr><td class="pad" style="padding:16px 32px 0 32px;">${stopka}${www}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '') // znaki sterujące z danych, też C1 (jak w ukladTekst)
}

function blokTekst(b: BlokGotowy): string {
  switch (b.typ) {
    case 'akapit':
      return b.tekst
    case 'uwaga':
      return `>> ${b.tekst.replace(/\n/g, '\n>> ')}`
    case 'kod':
      return b.tekst
        .split(/\r?\n/)
        .map((l) => `    ${l}`)
        .join('\n')
    case 'szczegoly':
      return b.wiersze.map((w) => `${w.etykieta}: ${w.wartosc}`).join('\n')
    case 'lista':
      return [...(b.naglowek ? [`${b.naglowek}:`] : []), ...b.elementy.map((x) => `- ${x}`)].join('\n')
    case 'przycisk':
      return `${b.etykieta}: ${b.url}`
  }
}

export function ukladTekst(tresc: TrescGotowa, k: KontekstMarki, odbiorca: Odbiorca): string {
  const czesci = [
    ...(odbiorca === 'biuro' ? ['[WIADOMOŚĆ WEWNĘTRZNA]'] : []),
    `${k.sklep.nazwa}\n${tresc.naglowek}`,
    ...tresc.bloki.map(blokTekst),
    `-- \n${[...stopkaLinie(k, odbiorca), ...(k.sklep.www ? [k.sklep.www] : [])].join('\n')}`,
  ]
  // NBSP z kwot zostaje (czytelny w każdym kliencie); znaki sterujące poza \n i \t usuwamy, też C1 (jak w temacie).
  return `${czesci.join('\n\n')}\n`.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}
