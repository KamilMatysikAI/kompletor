// Strona „Kompletor Druk (ustawienia)”: jeden plik HTML z CSS i skryptem, bez zależności i bez sieci (działa na
// komputerze bez internetu). Kolory i odstępy z tokenów panelu Kompletora (app/ui/tokeny.css), krój systemowy Segoe UI.
// Skrypt i style z jednorazowym nonce z nagłówka Content-Security-Policy; żadnych atrybutów style ani onclick.

export function stronaUstawien(nonce: string): string {
  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Kompletor Druk (ustawienia)</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<header class="gora">
  <div class="gora-w">
    <div class="marka"><span class="znak" aria-hidden="true"></span><span><b>Kompletor Druk</b> <span class="szary">ustawienia na tym komputerze</span></span></div>
    <button type="button" class="przycisk cichy" id="restart">Uruchom ponownie program</button>
  </div>
</header>

<main class="w">
  <section class="stan" id="stan" data-stan="czeka" aria-live="polite">
    <p class="stan-zdanie" id="stan-zdanie">Sprawdzam stan programu…</p>
    <p class="stan-rada" id="stan-rada" hidden></p>
    <dl class="stan-fakty">
      <div><dt>Ostatni wydruk</dt><dd id="ostatni-wydruk">—</dd></div>
      <div><dt>Ostatni błąd</dt><dd id="ostatni-blad">—</dd></div>
      <div><dt>Stanowisko</dt><dd id="stanowisko">—</dd></div>
    </dl>
    <p class="rada blad-rada" id="ostatni-blad-rada" hidden></p>
  </section>

  <section class="ostrzezenie" id="domyslna" hidden>
    <h2>Windows sam zmienia drukarkę domyślną</h2>
    <p>Program drukuje na wybranych niżej drukarkach, ale inne programy na tym komputerze mogą zacząć drukować nie tam, gdzie trzeba. Wyłącz to ustawienie:</p>
    <ol>
      <li>Kliknij Start, potem <b>Ustawienia</b>.</li>
      <li>Wejdź w <b>Bluetooth i urządzenia</b> (w Windows 10: <b>Urządzenia</b>), potem <b>Drukarki i skanery</b>.</li>
      <li>Wyłącz <b>Zezwalaj systemowi Windows na zarządzanie drukarką domyślną</b>.</li>
    </ol>
    <p class="szary">To ostrzeżenie zniknie samo po wyłączeniu.</p>
  </section>

  <div class="kolumny">
    <section class="karta drukarki" aria-labelledby="h-drukarki">
      <div class="karta-gora">
        <h2 id="h-drukarki">Drukarki</h2>
        <button type="button" class="przycisk cichy" id="odswiez">Odśwież listę</button>
      </div>
      <p class="szary wstep">Przy każdej drukarce wybierz, do czego służy. Gdy jest kilka drukarek do tego samego, pierwsza jest główna, a kolejne zapasowe. Nie wiesz, która to która? Kliknij „Wydruk próbny”: wyjdzie kartka z numerem z tej listy.</p>
      <div id="brakujace" class="ostrzezenie male" hidden></div>
      <ol class="lista" id="lista"><li class="pusto">Wczytuję drukarki z Windows…</li></ol>
    </section>

    <div class="bok">
      <section class="karta" aria-labelledby="h-polacz">
        <h2 id="h-polacz">Podłącz do Kompletora</h2>
        <p class="szary" id="polaczony">Ten komputer nie jest jeszcze podłączony.</p>
        <form id="polacz" autocomplete="off">
          <label for="kod">Kod połączenia</label>
          <p class="szary male-t" id="kod-opis">Kod weźmiesz w Kompletorze: Ustawienia → Wysyłka i druk → Druk. Zaczyna się od kmi_. Wklej go tutaj (Ctrl+V).</p>
          <input id="kod" name="kod" type="password" spellcheck="false" autocapitalize="off" aria-describedby="kod-opis kod-wynik" placeholder="kmi_…">
          <button type="submit" class="przycisk" id="kod-przycisk">Sprawdź i podłącz</button>
          <p class="wynik" id="kod-wynik" role="status" hidden></p>
        </form>
      </section>

      <section class="karta" aria-labelledby="h-zdarzenia">
        <h2 id="h-zdarzenia">Ostatnie zdarzenia</h2>
        <ol class="zdarzenia" id="zdarzenia"><li class="pusto">Brak wpisów.</li></ol>
      </section>
    </div>
  </div>
</main>

<div class="pasek" id="pasek" hidden>
  <div class="pasek-w">
    <span id="pasek-tekst">Masz niezapisane zmiany w drukarkach.</span>
    <span class="pasek-akcje">
      <button type="button" class="przycisk cichy" id="cofnij">Cofnij zmiany</button>
      <button type="button" class="przycisk" id="zapisz">Zapisz</button>
    </span>
  </div>
</div>
<div class="komunikat" id="komunikat" role="status" hidden></div>

<script nonce="${nonce}">${JS}</script>
</body>
</html>`
}

const IKONA_A4 = `<svg viewBox="0 0 16 20" aria-hidden="true"><path d="M1.5 1.5h9l4 4v13h-13z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 9h7M4.5 12h7M4.5 15h5" stroke="currentColor" stroke-width="1.2"/></svg>`
const IKONA_ETYKIETA = `<svg viewBox="0 0 20 16" aria-hidden="true"><rect x="1.5" y="1.5" width="17" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 5v6M7 5v6M8.5 5v6M11 5v6M12.5 5v6M15 5v6" stroke="currentColor" stroke-width="1.2"/></svg>`

const CSS = `
:root{--tlo:#f2f4f1;--karta:#fff;--karta-2:#f7f8f6;--tekst:#18221c;--tekst-2:#4b5750;--linia:#d9ded8;--linia-2:#c4cbc3;
--zielony:#2f6b4f;--zielony-2:#245540;--zielony-tlo:#e3efe7;--bursztyn:#8a4b06;--bursztyn-tlo:#fdf0d5;--bursztyn-linia:#ecc888;
--czerwony:#a8251b;--czerwony-tlo:#fce6e3;--czerwony-linia:#e7b3ad;--niebieski:#1f5a8a;--fokus:#1f5a8a;--r:6px;--r2:10px}
*{box-sizing:border-box}
html{font-size:15px}
body{margin:0;background:var(--tlo);color:var(--tekst);font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;line-height:1.45;padding-bottom:80px}
h2{font-family:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;font-size:1.2rem;font-weight:650;margin:0}
p{margin:0}
.szary{color:var(--tekst-2)}
.male-t{font-size:.9rem}
[hidden]{display:none!important}
:focus-visible{outline:3px solid var(--fokus);outline-offset:2px}
.w{max-width:1240px;margin:0 auto;padding:20px 24px}
.gora{background:var(--karta);border-bottom:1px solid var(--linia)}
.gora-w{max-width:1240px;margin:0 auto;padding:10px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.marka{display:flex;align-items:center;gap:10px}
.znak{width:22px;height:22px;border-radius:5px;background:var(--zielony);box-shadow:inset 0 -6px 0 var(--zielony-2)}
.przycisk{font:inherit;font-weight:600;border:1px solid var(--zielony);background:var(--zielony);color:#fff;border-radius:var(--r);padding:9px 16px;cursor:pointer;min-height:40px}
.przycisk:hover{background:var(--zielony-2)}
.przycisk.cichy{background:var(--karta);color:var(--zielony-2);border-color:var(--linia-2)}
.przycisk.cichy:hover{background:var(--zielony-tlo)}
.przycisk:disabled{opacity:.55;cursor:wait}

/* Stan: jedno duże zdanie z paskiem koloru po lewej — najważniejsza rzecz na stronie. */
.stan{background:var(--karta);border:1px solid var(--linia);border-left:10px solid var(--linia-2);border-radius:var(--r2);padding:18px 22px;margin-bottom:16px}
.stan[data-stan="ok"]{border-left-color:var(--zielony)}
.stan[data-stan="brak"],.stan[data-stan="blad"]{border-left-color:var(--czerwony)}
.stan[data-stan="niepodlaczony"],.stan[data-stan="ustawienia"]{border-left-color:var(--bursztyn)}
.stan-zdanie{font-family:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;font-size:1.95rem;font-weight:650;line-height:1.2;letter-spacing:-.01em}
.stan-rada{margin-top:6px;font-size:1.05rem;color:var(--tekst-2);max-width:72ch}
.stan-fakty{display:flex;flex-wrap:wrap;gap:8px 36px;margin:14px 0 0}
.stan-fakty div{min-width:0}
.stan-fakty dt{font-size:.85rem;color:var(--tekst-2)}
.stan-fakty dd{margin:0;font-weight:600;overflow-wrap:anywhere}
.rada{margin-top:8px;max-width:80ch}
.blad-rada{color:var(--czerwony)}

.ostrzezenie{background:var(--bursztyn-tlo);border:1px solid var(--bursztyn-linia);border-radius:var(--r2);padding:14px 18px;margin-bottom:16px;color:#4a2a05}
.ostrzezenie h2{font-size:1.05rem;margin-bottom:4px;color:var(--bursztyn)}
.ostrzezenie ol{margin:6px 0;padding-left:22px}
.ostrzezenie.male{padding:10px 14px;margin:10px 0 0}

.kolumny{display:grid;grid-template-columns:minmax(0,1.75fr) minmax(300px,1fr);gap:16px;align-items:start}
.bok{display:grid;gap:16px}
.karta{background:var(--karta);border:1px solid var(--linia);border-radius:var(--r2);padding:16px 18px}
.karta-gora{display:flex;justify-content:space-between;align-items:center;gap:10px}
.wstep{margin-top:4px;max-width:78ch}

/* Drukarki: wiersze jednej listy, numer z listy = numer na kartce próbnej. */
.lista{list-style:none;margin:12px 0 0;padding:0;border-top:1px solid var(--linia)}
.lista>li{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:6px 12px;padding:12px 0;border-bottom:1px solid var(--linia);align-items:center}
.nr{font-family:"Segoe UI Variable Display","Segoe UI",sans-serif;font-size:1.35rem;font-weight:700;color:var(--tekst-2);text-align:right;align-self:start;line-height:1.3}
.nazwa{font-weight:650;overflow-wrap:anywhere}
.stan-d{display:inline-flex;align-items:center;gap:6px;font-size:.9rem;color:var(--tekst-2)}
.kropka{width:9px;height:9px;border-radius:50%;background:var(--zielony);flex:none}
.stan-d.offline .kropka{background:#8a948d}.stan-d.blad .kropka{background:var(--czerwony)}
.stan-d.blad{color:var(--czerwony)}
.ustaw{grid-column:2/4;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}
.wybor{display:inline-flex;border:1px solid var(--linia-2);border-radius:var(--r);overflow:hidden;background:var(--karta-2)}
.wybor label{display:inline-flex;align-items:center;gap:7px;padding:7px 12px;cursor:pointer;border-left:1px solid var(--linia-2);min-height:38px;font-size:.95rem}
.wybor label:first-of-type{border-left:0}
.wybor input{position:absolute;opacity:0;width:1px;height:1px}
.wybor svg{width:18px;height:18px;flex:none}
.wybor label:has(input:checked){background:var(--zielony-tlo);color:var(--zielony-2);font-weight:650;box-shadow:inset 0 -3px 0 var(--zielony)}
.wybor label:has(input[value="POMIN"]:checked){background:#eceee9;color:var(--tekst-2);box-shadow:inset 0 -3px 0 var(--linia-2)}
.wybor label:has(input:focus-visible){outline:3px solid var(--fokus);outline-offset:-3px}
select{font:inherit;border:1px solid var(--linia-2);border-radius:var(--r);padding:7px 10px;min-height:38px;background:var(--karta)}
.proba{margin-left:auto}
.zmieniona{box-shadow:inset 4px 0 0 var(--bursztyn)}
.pusto{color:var(--tekst-2);padding:14px 0;display:block!important}

form{display:grid;gap:8px;margin-top:10px}
label[for="kod"]{font-weight:650}
input[type=password]{font:inherit;font-family:Consolas,monospace;border:1px solid var(--linia-2);border-radius:var(--r);padding:9px 11px;min-height:42px;width:100%}
.wynik{border-radius:var(--r);padding:9px 12px}
.wynik.ok{background:var(--zielony-tlo);color:var(--zielony-2)}
.wynik.zle{background:var(--czerwony-tlo);color:var(--czerwony)}

.zdarzenia{list-style:none;margin:10px 0 0;padding:0;max-height:420px;overflow:auto}
.zdarzenia li{padding:8px 0 8px 12px;border-bottom:1px solid var(--linia);border-left:3px solid transparent}
.zdarzenia li.uwaga{border-left-color:var(--bursztyn)}
.zdarzenia li.blad{border-left-color:var(--czerwony)}
.zdarzenia time{display:block;font-size:.8rem;color:var(--tekst-2)}
.zdarzenia .rada{font-size:.9rem;color:var(--tekst-2);margin-top:2px}

.pasek{position:fixed;left:0;right:0;bottom:0;background:var(--tekst);color:#fff;box-shadow:0 -4px 16px rgba(24,34,28,.18)}
.pasek-w{max-width:1240px;margin:0 auto;padding:10px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.pasek-akcje{display:flex;gap:8px}
.pasek .przycisk.cichy{background:transparent;color:#fff;border-color:#6b776f}
.komunikat{position:fixed;right:20px;bottom:76px;background:var(--tekst);color:#fff;padding:10px 14px;border-radius:var(--r);max-width:min(420px,calc(100vw - 40px))}
.komunikat.zle{background:var(--czerwony)}

@media (max-width:900px){.kolumny{grid-template-columns:1fr}}
@media (max-width:560px){
  html{font-size:15px}.w{padding:12px}.gora-w{padding:8px 12px}.marka .szary{display:none}
  .stan{padding:14px 14px 14px 16px}.stan-zdanie{font-size:1.5rem}
  .lista>li{grid-template-columns:26px minmax(0,1fr)}.ustaw{grid-column:1/3}.stan-d{grid-column:2}
  .wybor{width:100%}.wybor label{flex:1;justify-content:center;padding:7px 6px;font-size:.9rem}
  .proba{margin-left:0}
  .pasek-w{padding:10px 12px}
}
@media (prefers-reduced-motion:no-preference){.zmieniona{transition:box-shadow .2s}}
`

const JS = `
(function(){
'use strict';
var klucz = location.pathname.split('/')[2] || '';
var $ = function(id){ return document.getElementById(id); };
var IKONA_A4 = ${JSON.stringify(IKONA_A4)};
var IKONA_ET = ${JSON.stringify(IKONA_ETYKIETA)};
var drukarki = [];      // z serwera
var wybor = {};         // nazwa -> {rodzaj, kolejnosc}
var zapisane = {};      // stan po ostatnim odczycie / zapisie

function api(metoda, sciezka, dane){
  var o = { method: metoda, headers: { 'X-Kompletor-Klucz': klucz }, cache: 'no-store' };
  if (dane !== undefined){ o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(dane); }
  return fetch('/api/' + sciezka, o).then(function(r){
    return r.json().catch(function(){ return {}; }).then(function(j){
      if (!r.ok) throw new Error(j.blad || 'Program nie odpowiada. Odśwież stronę.');
      return j;
    });
  }, function(){ throw new Error('Program nie odpowiada. Jeśli przed chwilą był uruchamiany ponownie, odczekaj kilka sekund.'); });
}
function el(tag, klasa, tekst){ var e = document.createElement(tag); if (klasa) e.className = klasa; if (tekst !== undefined) e.textContent = tekst; return e; }
var zegar;
function komunikat(tekst, zle){ var k = $('komunikat'); k.textContent = tekst; k.className = 'komunikat' + (zle ? ' zle' : ''); k.hidden = false; clearTimeout(zegar); zegar = setTimeout(function(){ k.hidden = true; }, zle ? 9000 : 4000); }
function godzina(czas){ if (!czas) return ''; var dzis = new Date(); var d = czas.slice(0,10);
  var p = function(n){ return String(n).padStart(2,'0'); };
  var dzisTekst = dzis.getFullYear() + '-' + p(dzis.getMonth()+1) + '-' + p(dzis.getDate());
  return (d === dzisTekst ? 'dziś ' : czas.slice(8,10) + '.' + czas.slice(5,7) + ' ') + czas.slice(11,16); }

// ---------- stan ----------
function pokazStan(s){
  var p = s.polaczenie || {};
  var sekcja = $('stan');
  sekcja.dataset.stan = p.stan || 'czeka';
  $('stan-zdanie').textContent = p.opis || '';
  var rada = $('stan-rada'); rada.textContent = p.podpowiedz || (p.stan === 'ok' ? 'Program działa i czeka na wydruki.' : ''); rada.hidden = !rada.textContent;
  $('ostatni-wydruk').textContent = s.ostatniWydruk ? godzina(s.ostatniWydruk.czas) + ': ' + s.ostatniWydruk.tekst.replace(/^Wydrukowano /, '') : 'jeszcze nic';
  $('ostatni-blad').textContent = s.ostatniBlad ? godzina(s.ostatniBlad.czas) + ': ' + s.ostatniBlad.tekst : 'brak';
  var br = $('ostatni-blad-rada'); br.textContent = s.ostatniBlad && s.ostatniBlad.podpowiedz ? 'Co zrobić: ' + s.ostatniBlad.podpowiedz : ''; br.hidden = !br.textContent;
  $('stanowisko').textContent = s.stanowisko ? s.stanowisko + ' (wersja ' + s.wersja + ')' : 'wersja ' + s.wersja;
  $('polaczony').textContent = s.stanowisko && s.serwer ? 'Podłączony jako stanowisko „' + s.stanowisko + '” do ' + s.serwer + '. Nowy kod wklej tylko wtedy, gdy Kompletor o to prosi.' : 'Ten komputer nie jest jeszcze podłączony.';
  $('domyslna').hidden = s.windowsZarzadzaDomyslna !== true;
  var lista = $('zdarzenia'); lista.textContent = '';
  (s.zdarzenia || []).forEach(function(z){
    var li = el('li', z.rodzaj); var t = el('time', '', godzina(z.czas)); t.setAttribute('datetime', z.czas.replace(' ', 'T'));
    li.appendChild(t); li.appendChild(el('span', '', z.tekst));
    if (z.podpowiedz) li.appendChild(el('p', 'rada', z.podpowiedz));
    lista.appendChild(li);
  });
  if (!lista.children.length) lista.appendChild(el('li', 'pusto', 'Brak wpisów.'));
}
function odswiezStan(){ return api('GET', 'stan').then(pokazStan, function(e){ $('stan').dataset.stan = 'blad'; $('stan-zdanie').textContent = 'Program nie odpowiada.'; var r = $('stan-rada'); r.textContent = e.message; r.hidden = false; }); }

// ---------- drukarki ----------
var NAZWY_KOLEJNOSCI = function(n){ return n === 1 ? 'Główna' : n === 2 ? 'Zapasowa' : 'Zapasowa ' + (n - 1); };
function ilu(rodzaj){ return drukarki.filter(function(d){ return wybor[d.nazwa].rodzaj === rodzaj; }).length; }
function ponumeruj(rodzaj, przesuwana, pozycja){
  var grupa = drukarki.filter(function(d){ return wybor[d.nazwa].rodzaj === rodzaj && d.nazwa !== przesuwana; })
    .sort(function(a, b){ return (wybor[a.nazwa].kolejnosc || 99) - (wybor[b.nazwa].kolejnosc || 99) || a.numer - b.numer; })
    .map(function(d){ return d.nazwa; });
  if (przesuwana) grupa.splice(Math.max(0, Math.min(pozycja - 1, grupa.length)), 0, przesuwana);
  grupa.forEach(function(n, i){ wybor[n].kolejnosc = i + 1; });
}
function czyZmiany(){ return drukarki.some(function(d){ var a = wybor[d.nazwa], b = zapisane[d.nazwa]; return a.rodzaj !== b.rodzaj || (a.rodzaj !== 'POMIN' && a.kolejnosc !== b.kolejnosc); }); }
function rysujDrukarki(){
  var lista = $('lista'); lista.textContent = '';
  if (!drukarki.length){ lista.appendChild(el('li', 'pusto', 'Windows nie widzi żadnej drukarki. Podłącz i zainstaluj drukarkę w Windows, potem kliknij „Odśwież listę”.')); }
  drukarki.forEach(function(d){
    var w = wybor[d.nazwa];
    var li = el('li', zapisane[d.nazwa] && (zapisane[d.nazwa].rodzaj !== w.rodzaj || (w.rodzaj !== 'POMIN' && zapisane[d.nazwa].kolejnosc !== w.kolejnosc)) ? 'zmieniona' : '');
    li.appendChild(el('span', 'nr', String(d.numer)));
    var opis = el('div'); opis.appendChild(el('div', 'nazwa', d.nazwa));
    var st = el('span', 'stan-d ' + d.stan); st.appendChild(el('span', 'kropka'));
    st.appendChild(el('span', '', d.stan === 'gotowa' ? 'gotowa' + (d.opis ? ' (' + d.opis + ')' : '') : d.stan === 'offline' ? 'offline: sprawdź zasilanie i kabel' : (d.opis || 'błąd drukarki')));
    opis.appendChild(st); li.appendChild(opis);
    li.appendChild(el('span'));
    var ustaw = el('div', 'ustaw');
    var grupa = el('div', 'wybor'); grupa.setAttribute('role', 'radiogroup'); grupa.setAttribute('aria-label', 'Do czego służy drukarka ' + d.nazwa);
    [['A4', 'Kartki A4', IKONA_A4], ['TERMICZNA', 'Etykiety', IKONA_ET], ['POMIN', 'Nie używaj', '']].forEach(function(o){
      var lab = el('label'); var inp = document.createElement('input'); inp.type = 'radio'; inp.name = 'd' + d.numer; inp.value = o[0]; inp.checked = w.rodzaj === o[0];
      inp.addEventListener('change', function(){ var stary = w.rodzaj; w.rodzaj = o[0]; w.kolejnosc = undefined; if (stary !== 'POMIN') ponumeruj(stary); if (o[0] !== 'POMIN') ponumeruj(o[0], d.nazwa, 99); zmiana(); });
      lab.appendChild(inp); if (o[2]){ var ik = el('span'); ik.innerHTML = o[2]; lab.appendChild(ik.firstChild); } lab.appendChild(el('span', '', o[1])); grupa.appendChild(lab);
    });
    ustaw.appendChild(grupa);
    if (w.rodzaj !== 'POMIN'){
      var n = ilu(w.rodzaj);
      if (n > 1){
        var sel = document.createElement('select'); sel.setAttribute('aria-label', 'Kolejność drukarki ' + d.nazwa);
        for (var i = 1; i <= n; i++){ var op = document.createElement('option'); op.value = String(i); op.textContent = NAZWY_KOLEJNOSCI(i); op.selected = w.kolejnosc === i; sel.appendChild(op); }
        sel.addEventListener('change', function(){ ponumeruj(w.rodzaj, d.nazwa, Number(sel.value)); zmiana(); });
        ustaw.appendChild(sel);
      } else ustaw.appendChild(el('span', 'szary', 'Główna'));
    }
    var b = el('button', 'przycisk cichy proba', 'Wydruk próbny'); b.type = 'button';
    b.addEventListener('click', function(){ b.disabled = true; b.textContent = 'Drukuję…';
      api('POST', 'proba', { nazwa: d.nazwa }).then(function(){ komunikat('Wysłano kartkę z numerem ' + d.numer + ' na „' + d.nazwa + '”. Sprawdź, z której drukarki wyszła.'); }, function(e){ komunikat(e.message, true); })
        .then(function(){ b.disabled = false; b.textContent = 'Wydruk próbny'; }); });
    ustaw.appendChild(b);
    li.appendChild(ustaw);
    lista.appendChild(li);
  });
}
function zmiana(){ rysujDrukarki(); $('pasek').hidden = !czyZmiany(); }
function odswiezDrukarki(wymus){
  if (!wymus && czyZmiany()) return Promise.resolve();
  return api('GET', 'drukarki').then(function(j){
    drukarki = j.drukarki || []; wybor = {}; zapisane = {};
    drukarki.forEach(function(d){ wybor[d.nazwa] = { rodzaj: d.rodzaj, kolejnosc: d.kolejnosc }; zapisane[d.nazwa] = { rodzaj: d.rodzaj, kolejnosc: d.kolejnosc }; });
    var br = $('brakujace'); br.textContent = '';
    (j.brakujace || []).forEach(function(b){ br.appendChild(el('p', '', 'Drukarki „' + b.nazwa + '” (' + (b.rodzaj === 'A4' ? 'kartki A4' : 'etykiety') + ') nie ma teraz w Windows. Sprawdź, czy jest włączona i podłączona, albo wybierz inną drukarkę i zapisz.')); });
    br.hidden = !br.children.length;
    zmiana();
  }, function(e){ var l = $('lista'); l.textContent = ''; l.appendChild(el('li', 'pusto', e.message)); });
}
$('zapisz').addEventListener('click', function(){
  var b = $('zapisz'); b.disabled = true;
  var lista = drukarki.slice().sort(function(a, c){ return (wybor[a.nazwa].kolejnosc || 99) - (wybor[c.nazwa].kolejnosc || 99) || a.numer - c.numer; })
    .map(function(d){ return { nazwa: d.nazwa, rodzaj: wybor[d.nazwa].rodzaj }; });
  api('POST', 'zapisz', { drukarki: lista }).then(function(){ komunikat('Zapisano. Program używa już nowych ustawień.'); $('kod-wynik').hidden = true; return odswiezDrukarki(true).then(odswiezStan); }, function(e){ komunikat(e.message, true); })
    .then(function(){ b.disabled = false; });
});
$('cofnij').addEventListener('click', function(){ odswiezDrukarki(true); });
$('odswiez').addEventListener('click', function(){ if (czyZmiany() && !confirm('Masz niezapisane zmiany. Odświeżyć listę i je porzucić?')) return; odswiezDrukarki(true); });

// ---------- kod połączenia ----------
$('polacz').addEventListener('submit', function(ev){
  ev.preventDefault();
  var pole = $('kod'), wynik = $('kod-wynik'), b = $('kod-przycisk');
  if (!pole.value.trim()){ wynik.className = 'wynik zle'; wynik.textContent = 'Najpierw wklej kod połączenia.'; wynik.hidden = false; return; }
  b.disabled = true; b.textContent = 'Sprawdzam w Kompletorze…'; wynik.hidden = true;
  api('POST', 'polacz', { kod: pole.value }).then(function(j){
    pole.value = ''; wynik.className = 'wynik ok'; wynik.textContent = 'Podłączono: stanowisko „' + j.stanowisko + '”. Teraz wybierz drukarki obok i kliknij „Zapisz”.'; wynik.hidden = false;
    return odswiezStan();
  }, function(e){ wynik.className = 'wynik zle'; wynik.textContent = e.message; wynik.hidden = false; })
    .then(function(){ b.disabled = false; b.textContent = 'Sprawdź i podłącz'; });
});

// ---------- ponowne uruchomienie ----------
$('restart').addEventListener('click', function(){
  if (!confirm('Uruchomić program ponownie? Drukowanie zatrzyma się na kilka sekund.')) return;
  var b = $('restart'); b.disabled = true;
  api('POST', 'uruchom-ponownie', {}).then(function(){
    komunikat('Uruchamiam program ponownie…');
    var proby = 0;
    var t = setInterval(function(){ proby++; api('GET', 'stan').then(function(s){ clearInterval(t); b.disabled = false; pokazStan(s); komunikat('Program działa.'); }, function(){ if (proby > 30){ clearInterval(t); b.disabled = false; komunikat('Program nie wrócił. Wyloguj się z Windows i zaloguj ponownie.', true); } }); }, 2000);
  }, function(e){ b.disabled = false; komunikat(e.message, true); });
});

odswiezStan(); odswiezDrukarki(true);
setInterval(odswiezStan, 10000);
setInterval(function(){ odswiezDrukarki(false); }, 30000);
})();
`
