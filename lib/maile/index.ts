// Moduł maili do klientów i biura: szablony domyślne, silnik, układ HTML + tekst. Bez wysyłki.
export { BladSzablonu, escapeHtml, formatujDate, formatujDateCzas, formatujKwote, wCiaguDniRoboczych } from './formaty'
export {
  nazwaPlikuFaktury,
  renderujMail,
  sprawdzNadpisanie,
  type DaneBladFaktury,
  type DaneBrakPlatnosci,
  type DaneFaktura,
  type DaneGotoweDoOdbioru,
  type DaneMaili,
  type DaneNieudanaPlatnosc,
  type DaneNiskiStan,
  type DaneResetHasla,
  type DaneZwrotu,
  type PdfFaktury,
  type PozycjaMaila,
} from './mail'
export { renderujTekst, ZMIENNE_WSPOLNE } from './silnik'
export { PRZYPOMNIENIE_O_PLATNOSCI_PO_DNIACH_ROBOCZYCH, SZABLONY_DOMYSLNE } from './szablony'
export type * from './typy'
