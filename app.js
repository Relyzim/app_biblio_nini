/* ══════════════════════════════════════════════════════════════════════
           Biblio-ninoush — v2
           • Persistance triple couche : localStorage + IndexedDB + window.storage
           • Scanner code-barres : BarcodeDetector natif → ZXing → Quagga → photo
           • Couvertures réelles : Google Books + Open Library, avec repli en chaîne
           ══════════════════════════════════════════════════════════════════════ */

// ── ÉTAT ──────────────────────────────────────────────────────────────────
let books = [];
let editId = null;
let currentFilter = 'all';
let currentStatus = 'read';
let currentEmoji = '📕';
let currentCover = '';
let currentRating = 0;
let currentQuotes = [];
let dragSrcId = null;

const STORAGE_KEY = 'bibliotrack_books';
const SETTINGS_KEY = 'bibliotrack_settings';
const SCHEMA = 2;

// Réglages persistants (thème, défi lecture). Sauvés séparément des livres.
let settings = { theme: 'light', challengeYear: new Date().getFullYear(), challengeGoal: 0 };

function loadSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) settings = Object.assign(settings, JSON.parse(raw));
    } catch (e) { }
}
function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { }
    if (window.storage) { try { window.storage.set(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { } }
    try { idb.set(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { }
}

// ── INDEXEDDB ─────────────────────────────────────────────────────────────
const idb = (() => {
    let dbp = null;
    function open() {
        if (dbp) return dbp;
        dbp = new Promise((res, rej) => {
            if (!('indexedDB' in window)) return rej(new Error('IndexedDB indisponible'));
            const rq = indexedDB.open('bibliotrack', 1);
            rq.onupgradeneeded = () => {
                if (!rq.result.objectStoreNames.contains('kv')) rq.result.createObjectStore('kv');
            };
            rq.onsuccess = () => res(rq.result);
            rq.onerror = () => rej(rq.error);
            rq.onblocked = () => rej(new Error('bloqué'));
        }).catch(e => { dbp = null; throw e; });
        return dbp;
    }
    return {
        async get(k) {
            const db = await open();
            return new Promise((res, rej) => {
                const r = db.transaction('kv', 'readonly').objectStore('kv').get(k);
                r.onsuccess = () => res(r.result);
                r.onerror = () => rej(r.error);
            });
        },
        async set(k, v) {
            const db = await open();
            return new Promise((res, rej) => {
                const tx = db.transaction('kv', 'readwrite');
                tx.objectStore('kv').put(v, k);
                tx.oncomplete = () => res(true);
                tx.onerror = () => rej(tx.error);
            });
        }
    };
})();

// ── SAUVEGARDE / CHARGEMENT ───────────────────────────────────────────────
function payload() {
    return { schema: SCHEMA, savedAt: Date.now(), count: books.length, books };
}

let saveTimer = null;
function save() {                       // écriture différée (regroupe les rafales)
    saveLocal();                        // localStorage : immédiat et synchrone
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDeep, 300);
}

function saveLocal() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload()));
        markSaved();
    } catch (e) {
        setSaveState('⚠️ Stockage du navigateur plein — exportez une sauvegarde');
    }
}

async function saveDeep() {
    const data = JSON.stringify(payload());
    try { await idb.set(STORAGE_KEY, data); } catch (e) { }
    if (window.storage) { try { await window.storage.set(STORAGE_KEY, data); } catch (e) { } }
}

function saveNow() { saveLocal(); saveDeep(); }

function parsePayload(raw) {
    if (!raw) return null;
    try {
        const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(o)) return { savedAt: 0, books: o };            // ancien format v1
        if (o && Array.isArray(o.books)) return { savedAt: o.savedAt || 0, books: o.books };
    } catch (e) { }
    return null;
}

async function loadBooks() {
    const cands = [];
    try { cands.push(parsePayload(localStorage.getItem(STORAGE_KEY))); } catch (e) { }
    try { cands.push(parsePayload(await idb.get(STORAGE_KEY))); } catch (e) { }
    if (window.storage) {
        try {
            const r = await window.storage.get(STORAGE_KEY);
            cands.push(parsePayload(r && r.value));
        } catch (e) { }
    }
    // on garde la source la plus récente ; à égalité, la plus fournie
    const best = cands.filter(Boolean).sort((a, b) =>
        (b.savedAt - a.savedAt) || (b.books.length - a.books.length))[0];
    books = best ? best.books.map(migrate) : [];
    if (best) { saveLocal(); saveDeep(); }   // réaligne les trois couches après migration
}

function migrate(b) {
    let rating = parseFloat(b.rating) || 0;
    rating = Math.max(0, Math.min(5, Math.round(rating * 2) / 2)); // pas de 0,5
    return {
        id: b.id || uid(),
        title: b.title || '',
        author: b.author || '',
        pages: parseInt(b.pages) || 0,
        genre: b.genre || '',
        year: b.year || null,
        notes: b.notes || '',
        status: ['read', 'reading', 'pal', 'wish'].includes(b.status) ? b.status : 'pal',
        emoji: b.emoji || '📕',
        rating: rating,
        cover: safeCoverUrl(b.cover),
        coverAlt: safeCoverUrl(b.coverAlt),
        isbn: b.isbn || '',
        progress: b.progress || 0,
        favorite: !!b.favorite,
        series: b.series || '',
        seriesNum: (b.seriesNum === 0 || b.seriesNum) ? (parseFloat(b.seriesNum) || null) : null,
        quotes: Array.isArray(b.quotes)
            ? b.quotes.filter(q => q && q.text).map(q => ({ text: String(q.text), page: parseInt(q.page) || null }))
            : [],
        finishedAt: b.finishedAt || (b.status === 'read' ? (b.addedAt || Date.now()) : null),
        addedAt: b.addedAt || Date.now()
    };
}

function markSaved() {
    const d = new Date();
    const h = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    setSaveState(`💾 Enregistré à ${h} · ${books.length} livre${books.length > 1 ? 's' : ''}`);
}
function setSaveState(txt) {
    const el = document.getElementById('save-state');
    if (el) el.textContent = txt;
    const em = document.getElementById('save-state-mobile');
    if (em) em.textContent = txt;
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// ── ONGLETS ───────────────────────────────────────────────────────────────
const TABS = ['all', 'reading', 'read', 'pal', 'wish', 'stats'];
const TITLES = {
    all: 'Tous les <span>livres</span>',
    reading: 'Lectures <span>en cours</span>',
    read: 'Livres <span>lus</span>',
    pal: 'Pile à <span>lire</span>',
    wish: 'Liste d\'<span>envie</span>',
    stats: '<span>Calculateurs</span>'
};

function switchTab(tab) {
    TABS.forEach(t => {
        const p = document.getElementById('panel-' + t);
        if (p) p.classList.toggle('active', t === tab);
    });
    document.querySelectorAll('.nav-item').forEach(el => {
        el.classList.toggle('active', (el.getAttribute('onclick') || '').includes("'" + tab + "'"));
    });
    document.querySelectorAll('.mnav-item').forEach(el => {
        el.classList.toggle('active', el.dataset.tab === tab);
    });
    document.getElementById('topbar-title').innerHTML = TITLES[tab] || tab;
    const c = document.querySelector('.content');
    if (c) c.scrollTop = 0;
    window.scrollTo(0, 0);
    renderAll();
}

function setFilter(f, btn) {
    currentFilter = f;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderGrid();
}

// ── COUVERTURES ───────────────────────────────────────────────────────────
// Ne laisse passer qu'une image sûre : https/http, ou data:image/... (couverture importée).
// Tout le reste (javascript:, data:text/html, vbscript:, blob:, etc.) est rejeté → ''.
function safeCoverUrl(url) {
    const s = String(url || '').trim();
    if (!s) return '';
    // URL relative (chemin d'icône) : sans schéma ni "://", on considère sûr
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && !s.startsWith('//')) return s;
    // Image encodée en base64/URL : uniquement les vrais types image
    if (/^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml);/i.test(s)) return s;
    // Schémas web classiques uniquement
    if (/^https?:\/\//i.test(s)) return s;
    return '';
}

function coverCandidates(b) {
    const list = [];
    const c = safeCoverUrl(b.cover);
    const ca = safeCoverUrl(b.coverAlt);
    if (c) list.push(c);
    if (ca) list.push(ca);
    if (b.isbn) {
        list.push(`https://covers.openlibrary.org/b/isbn/${b.isbn}-L.jpg?default=false`);
        list.push(`https://books.google.com/books/content?vid=ISBN${b.isbn}&printsec=frontcover&img=1&zoom=1`);
    }
    return [...new Set(list.filter(Boolean))];
}

function coverImg(b, cls, fallbackHtml) {
    const urls = coverCandidates(b);
    if (!urls.length) return fallbackHtml;
    const rest = esc(JSON.stringify(urls.slice(1)));
    return `<img class="${cls}" src="${esc(urls[0])}" alt="Couverture de ${esc(b.title)}" loading="lazy"
              data-rest="${rest}" data-fb="${esc(fallbackHtml)}" onerror="coverErr(this)">`;
}

function coverErr(img) {
    let rest = [];
    try { rest = JSON.parse(img.dataset.rest || '[]'); } catch (e) { }
    if (rest.length) {
        const next = rest.shift();
        img.dataset.rest = JSON.stringify(rest);
        img.src = next;
    } else {
        const fb = img.dataset.fb || '📕';
        const holder = document.createElement('span');
        holder.style.display = 'contents';
        holder.innerHTML = fb;
        img.replaceWith(holder);
    }
}

function gridFallback(b) {
    return `<div class="cover-fallback fb-${b.status}" style="background:${COVER_COLORS[b.status] || COVER_COLORS.pal}">
                <div style="font-size:34px">${b.emoji || '📕'}</div>
                <div class="fb-title">${esc(b.title)}</div></div>`;
}
function thumbFallback(b) {
    return `<div class="cover-thumb-fb">${b.emoji || '📕'}</div>`;
}

const COVER_COLORS = {
    read: 'linear-gradient(135deg,#e8f3ec,#cfe9db)',
    reading: 'linear-gradient(135deg,#e8eaf8,#d0d6f3)',
    pal: 'linear-gradient(135deg,#efeaf8,#ddd0f2)',
    wish: 'linear-gradient(135deg,#fbe9ec,#f6ccd5)',
};

// ── RENDU ─────────────────────────────────────────────────────────────────
function renderAll() {
    renderGrid();
    renderList('reading');
    renderList('read');
    renderList('pal');
    renderList('wish');
    updateStats();
    updateCalc();
    updateBadges();
}

function getFiltered() {
    const q = (document.getElementById('search-input').value || '').trim().toLowerCase();
    let out = books.filter(b => {
        const okStatus = currentFilter === 'all' ? true
            : currentFilter === 'fav' ? b.favorite
                : b.status === currentFilter;
        const okQ = !q || (b.title + ' ' + b.author + ' ' + (b.genre || '') + ' ' + (b.isbn || '') + ' ' + (b.series || ''))
            .toLowerCase().includes(q);
        return okStatus && okQ;
    });
    const sort = (document.getElementById('sort-select') || {}).value || 'added';
    const cmp = {
        added: (a, b) => b.addedAt - a.addedAt,
        title: (a, b) => a.title.localeCompare(b.title, 'fr'),
        author: (a, b) => (a.author || '').localeCompare(b.author || '', 'fr'),
        pages: (a, b) => (b.pages || 0) - (a.pages || 0),
        rating: (a, b) => (b.rating || 0) - (a.rating || 0),
        year: (a, b) => (b.year || 0) - (a.year || 0),
        series: (a, b) => (a.series || '~').localeCompare(b.series || '~', 'fr') || ((a.seriesNum || 0) - (b.seriesNum || 0)),
    }[sort];
    return cmp ? out.slice().sort(cmp) : out;
}

function renderGrid() {
    const grid = document.getElementById('grid-all');
    const empty = document.getElementById('empty-all');
    const filtered = getFiltered();

    const sampleBtn = document.getElementById('sample-btn');
    if (sampleBtn) sampleBtn.style.display = books.length === 0 ? 'inline-flex' : 'none';

    if (filtered.length === 0) {
        grid.style.display = 'none';
        grid.innerHTML = '';
        empty.style.display = 'block';
        return;
    }
    grid.style.display = 'grid';
    empty.style.display = 'none';

    grid.innerHTML = filtered.map(b => `
            <div class="book-card${b.favorite ? ' is-fav' : ''}">
              <div class="book-cover" onclick="editBook('${b.id}')" title="Modifier ${esc(b.title)}">
        ${coverImg(b, 'real-cover', gridFallback(b))}
        <div class="book-status-dot dot-${b.status}"></div>
        <button class="fav-heart${b.favorite ? ' on' : ''}" title="Favori"
          onclick="toggleFavorite('${b.id}', event)">${b.favorite ? '❤️' : '🤍'}</button>
        ${b.quotes && b.quotes.length ? `<span class="quote-chip" title="${b.quotes.length} citation(s)">❝ ${b.quotes.length}</span>` : ''}
              </div>
              <div class="book-info">
        <div class="book-title">${esc(b.title)}</div>
        <div class="book-author">${esc(b.author || 'Auteur inconnu')}</div>
        ${b.series ? `<div class="series-tag">📖 ${esc(b.series)}${b.seriesNum ? ' · T.' + b.seriesNum : ''}</div>` : ''}
        ${b.rating ? `<div class="card-stars">${starStr(b.rating)}</div>` : ''}
        ${b.status === 'reading' && b.pages ? `<div class="prog-mini"><i style="width:${pct(b)}%"></i></div>` : ''}
        <div class="book-meta">
          <span class="book-pages">${b.pages ? b.pages + ' p.' : '—'}</span>
          <span class="book-badge badge-${b.status}">${statusLabel(b.status)}</span>
        </div>
              </div>
              <div class="book-actions">
        <button class="action-btn" onclick="editBook('${b.id}')">✏️ Éditer</button>
        <button class="action-btn del" onclick="deleteBook('${b.id}')">🗑</button>
              </div>
            </div>`).join('');
}

function pct(b) {
    if (!b.pages) return 0;
    return Math.min(100, Math.round((b.progress || 0) / b.pages * 100));
}

function renderList(status) {
    const list = document.getElementById('list-' + status);
    const empty = document.getElementById('empty-' + status);
    if (!list) return;
    const filtered = books.filter(b => b.status === status);

    if (status === 'pal') {
        const palPages = filtered.reduce((s, b) => s + (parseInt(b.pages) || 0), 0);
        document.getElementById('pal-subtitle').textContent =
            filtered.length ? `— ${palPages.toLocaleString('fr-FR')} pages à lire` : '';
    }

    if (filtered.length === 0) {
        list.style.display = 'none';
        list.innerHTML = '';
        empty.style.display = 'block';
        return;
    }
    list.style.display = 'flex';
    empty.style.display = 'none';

    list.innerHTML = filtered.map(b => `
            <div class="book-list-item"
              ${status === 'pal' ? `draggable="true" ondragstart="onDragStart(event,'${b.id}')" ondragover="event.preventDefault();this.classList.add('drag-over')" ondragleave="this.classList.remove('drag-over')"` : ''}
              id="item-${b.id}">
              ${status === 'pal' ? '<span class="drag-handle" title="Glisser pour réordonner">⠿</span>' : ''}
              ${coverImg(b, 'cover-thumb', thumbFallback(b))}
              <div class="book-list-info">
        <div class="book-list-title">${esc(b.title)}</div>
        <div class="book-list-author">${esc(b.author || 'Auteur inconnu')}</div>
        <div class="book-list-meta">
          ${b.series ? `<span class="note-tag" style="color:var(--pal)">📖 ${esc(b.series)}${b.seriesNum ? ' T.' + b.seriesNum : ''}</span>` : ''}
          ${b.pages ? `<span class="note-tag">📄 ${b.pages} pages</span>` : ''}
          ${b.genre ? `<span class="note-tag">🏷 ${esc(b.genre)}</span>` : ''}
          ${b.year ? `<span class="note-tag">📅 ${b.year}</span>` : ''}
          ${b.rating ? `<span class="note-tag" style="color:var(--gold)">${starStr(b.rating)}</span>` : ''}
          ${b.quotes && b.quotes.length ? `<span class="note-tag">❝ ${b.quotes.length}</span>` : ''}
        </div>
        ${status === 'reading' ? `
          <div class="prog-mini"><i style="width:${pct(b)}%"></i></div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:11px;color:var(--ink3)">
            <span>Page</span>
            <input type="number" min="0" value="${b.progress || 0}" style="width:76px;padding:3px 6px;border:1px solid var(--border);border-radius:6px;font-family:'DM Sans'"
              onchange="setProgress('${b.id}',this.value)">
            <span>${b.pages ? '/ ' + b.pages + ' — ' + pct(b) + '%' : ''}</span>
          </div>` : ''}
              </div>
              <div class="book-list-actions">
        <button class="icon-btn" title="${b.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}" onclick="toggleFavorite('${b.id}', event)">${b.favorite ? '❤️' : '🤍'}</button>
        ${status !== 'read' ? `<button class="icon-btn" title="Marquer comme lu" onclick="markAs('${b.id}','read')">✅</button>` : ''}
        ${status !== 'reading' ? `<button class="icon-btn" title="Commencer la lecture" onclick="markAs('${b.id}','reading')">📖</button>` : ''}
        ${status === 'wish' ? `<button class="icon-btn" title="Ajouter à la PAL" onclick="markAs('${b.id}','pal')">📚</button>` : ''}
        ${status === 'pal' ? `<button class="icon-btn" title="Ajouter aux envies" onclick="markAs('${b.id}','wish')">⭐</button>` : ''}
        <button class="icon-btn" title="Éditer" onclick="editBook('${b.id}')">✏️</button>
        <button class="icon-btn del" title="Supprimer" onclick="deleteBook('${b.id}')">🗑</button>
              </div>
            </div>`).join('');
}

function setProgress(id, val) {
    const n = Math.max(0, parseInt(val) || 0);
    books = books.map(b => b.id === id ? { ...b, progress: n } : b);
    save();
    renderAll();
}

function updateStats() {
    const total = books.length;
    const read = books.filter(b => b.status === 'read');
    const pal = books.filter(b => b.status === 'pal');
    const wish = books.filter(b => b.status === 'wish');
    const pagesRead = read.reduce((s, b) => s + (parseInt(b.pages) || 0), 0);
    const pagesPal = pal.reduce((s, b) => s + (parseInt(b.pages) || 0), 0);
    const p = total ? Math.round(read.length / total * 100) : 0;

    set('sc-total', total);
    set('sc-read', read.length);
    set('sc-read-pct', p + '% du total');
    set('sc-pages', pagesRead.toLocaleString('fr-FR'));
    set('sc-pal-pages', pagesPal.toLocaleString('fr-FR'));
    set('sidebar-pages', pagesRead.toLocaleString('fr-FR'));
    set('sidebar-read', read.length);
    set('sidebar-pal', pal.length);
    set('sidebar-wish', wish.length);
}

function updateBadges() {
    set('badge-all', books.length);
    ['reading', 'read', 'pal', 'wish'].forEach(s =>
        set('badge-' + s, books.filter(b => b.status === s).length));
    const readingN = books.filter(b => b.status === 'reading').length;
    const mb = document.getElementById('mnav-badge-reading');
    if (mb) { mb.textContent = readingN; mb.classList.toggle('show', readingN > 0); }
}

function updateCalc() {
    const read = books.filter(b => b.status === 'read');
    const pal = books.filter(b => b.status === 'pal');
    const wish = books.filter(b => b.status === 'wish');
    const total = books.length;
    const pagesRead = read.reduce((s, b) => s + (parseInt(b.pages) || 0), 0);
    const pagesPal = pal.reduce((s, b) => s + (parseInt(b.pages) || 0), 0);
    const p = total ? Math.round(read.length / total * 100) : 0;

    set('calc-read', read.length);
    set('calc-pages', pagesRead.toLocaleString('fr-FR'));
    set('calc-pal-pages', pagesPal.toLocaleString('fr-FR'));
    set('calc-wish', wish.length);
    set('calc-pct', p + '%');
    document.getElementById('calc-prog').style.width = p + '%';

    const equiv = document.getElementById('page-equiv');
    const harry = 223, tolstoy = 1225, lotr = 1178;
    equiv.innerHTML = [
        ['📖', 'Harry Potter T1', Math.floor(pagesRead / harry) + ' fois'],
        ['📚', 'Guerre & Paix', (pagesRead / tolstoy).toFixed(1) + 'x'],
        ['🧙', 'Le Seigneur des Anneaux', (pagesRead / lotr).toFixed(1) + 'x'],
    ].map(([e, l, v]) => `
            <div style="display:flex;align-items:center;justify-content:space-between;font-size:12px">
              <span style="color:var(--ink2)">${e} ${l}</span>
              <span style="font-weight:600;color:var(--gold)">${v}</span>
            </div>`).join('');

    const palTime = document.getElementById('pal-time');
    if (pagesPal > 0) {
        const d30 = Math.ceil(pagesPal / 30);
        const d50 = Math.ceil(pagesPal / 50);
        palTime.innerHTML = `
              <div style="font-size:11px;color:var(--ink3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Estimation de lecture</div>
              <div style="display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;justify-content:space-between;font-size:12px">
          <span style="color:var(--ink2)">🐢 30 pages/jour</span>
          <span style="font-weight:600;color:var(--pal)">${d30} jours (~${Math.max(1, Math.round(d30 / 30))} mois)</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px">
          <span style="color:var(--ink2)">🐇 50 pages/jour</span>
          <span style="font-weight:600;color:var(--pal)">${d50} jours (~${Math.max(1, Math.round(d50 / 30))} mois)</span>
        </div>
              </div>`;
    } else {
        palTime.innerHTML = `<p style="font-size:12px;color:var(--ink3)">Ajoutez des livres à votre PAL pour estimer le temps de lecture.</p>`;
    }

    const wishPages = wish.reduce((s, b) => s + (parseInt(b.pages) || 0), 0);
    document.getElementById('wish-info').innerHTML = wishPages > 0
        ? `<div style="font-size:12px;color:var(--ink2)">${wishPages.toLocaleString('fr-FR')} pages au total dans votre liste</div>`
        : `<div style="font-size:12px;color:var(--ink3)">Aucune page renseignée.</div>`;

    renderGenreChart(read, 'genre-chart', '#2d6a4f');

    const wGenres = {};
    wish.forEach(b => { if (b.genre) wGenres[b.genre] = (wGenres[b.genre] || 0) + 1; });
    const genreColors = ['#7b4f9e', '#c0392b', '#2d6a4f', '#c9973a', '#185FA5', '#8B6914'];
    document.getElementById('wish-genres').innerHTML = Object.entries(wGenres)
        .sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([g, n], i) => `<span class="genre-tag-sm" style="background:${genreColors[i % genreColors.length]}22;color:${genreColors[i % genreColors.length]}">${esc(g)} (${n})</span>`)
        .join('') || `<span style="font-size:12px;color:var(--ink3)">Aucun genre renseigné.</span>`;

    // Rythme
    const year = new Date().getFullYear();
    const thisYear = read.filter(b => b.year === year);
    set('calc-year', thisYear.length);
    const month = new Date().getMonth() + 1;
    const rhythm = document.getElementById('rhythm-info');
    const perMonth = (thisYear.length / month);
    rhythm.innerHTML = thisYear.length
        ? `<div style="font-size:12px;color:var(--ink2)">Soit <b>${perMonth.toFixed(1)}</b> livre(s) par mois.<br>
           Au même rythme : <b>${Math.round(perMonth * 12)}</b> livres d'ici fin ${year}.<br>
           ${thisYear.reduce((s, b) => s + (b.pages || 0), 0).toLocaleString('fr-FR')} pages lues en ${year}.</div>`
        : `<div style="font-size:12px;color:var(--ink3)">Renseignez l'année de lecture de vos livres lus pour suivre votre rythme.</div>`;

    // Notes (regroupées par étoile entière, demi-notes incluses)
    const rated = books.filter(b => b.rating > 0);
    set('calc-avg', rated.length ? (rated.reduce((s, b) => s + b.rating, 0) / rated.length).toFixed(1) : '—');
    const dist = document.getElementById('rating-dist');
    if (rated.length) {
        const bucket = n => rated.filter(b => Math.ceil(b.rating) === n).length;
        const max = Math.max(...[1, 2, 3, 4, 5].map(bucket), 1);
        dist.innerHTML = [5, 4, 3, 2, 1].map(n => {
            const c = bucket(n);
            return `<div class="chart-bar-item">
            <div class="chart-bar-label" style="color:var(--gold)">${'★'.repeat(n)}</div>
            <div class="chart-bar-track"><div class="chart-bar-fill" style="width:${max ? Math.round(c / max * 100) : 0}%;background:var(--gold)"></div></div>
            <div class="chart-bar-val">${c}</div></div>`;
        }).join('');
    } else {
        dist.innerHTML = `<div style="font-size:12px;color:var(--ink3)">Notez vos lectures pour voir la répartition.</div>`;
    }

    updateChallenge();
    updateMonthlyStats();
}

// ── DÉFI LECTURE ──────────────────────────────────────────────────────────
function finishedInYear(y) {
    return books.filter(b => b.status === 'read' &&
        ((b.finishedAt && new Date(b.finishedAt).getFullYear() === y) ||
            (!b.finishedAt && b.year === y)));
}

function updateChallenge() {
    const y = new Date().getFullYear();
    if (settings.challengeYear !== y) { settings.challengeYear = y; } // suit l'année en cours
    const done = finishedInYear(y).length;
    const goal = settings.challengeGoal || 0;
    const pctv = goal ? Math.min(100, Math.round(done / goal * 100)) : 0;

    set('challenge-year', y);
    set('challenge-num', done);
    set('challenge-den', '/ ' + (goal || '—'));
    const ring = document.getElementById('challenge-ring');
    if (ring) ring.style.setProperty('--p', pctv);
    const gi = document.getElementById('challenge-goal');
    if (gi && document.activeElement !== gi) gi.value = goal || '';

    const msg = document.getElementById('challenge-msg');
    if (!goal) {
        msg.innerHTML = `Fixez-vous un objectif de lecture pour <b>${y}</b> et suivez votre progression.`;
    } else if (done >= goal) {
        msg.innerHTML = `🎉 Objectif atteint ! <b>${done}</b> livres lus sur ${goal}. Bravo !`;
    } else {
        const remaining = goal - done;
        const monthsLeft = 12 - new Date().getMonth();
        const perMonth = (remaining / Math.max(1, monthsLeft)).toFixed(1);
        msg.innerHTML = `Plus que <b>${remaining}</b> livre(s) d'ici la fin de l'année — environ <b>${perMonth}</b> par mois.`;
    }
}

function setChallengeGoal(v) {
    settings.challengeGoal = Math.max(0, parseInt(v) || 0);
    settings.challengeYear = new Date().getFullYear();
    saveSettings();
    updateChallenge();
}

// ── LECTURES DANS LE TEMPS ────────────────────────────────────────────────
const MONTHS_FR = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc'];

function updateMonthlyStats() {
    const y = new Date().getFullYear();
    const finished = finishedInYear(y);
    const perMonth = new Array(12).fill(0);
    finished.forEach(b => {
        const m = b.finishedAt ? new Date(b.finishedAt).getMonth() : null;
        if (m !== null) perMonth[m]++;
        else perMonth[Math.min(11, new Date().getMonth())]++; // sans date précise : mois courant
    });
    const max = Math.max(...perMonth, 1);

    set('months-year', y);
    set('months-total', `${finished.length} livre${finished.length > 1 ? 's' : ''} terminé${finished.length > 1 ? 's' : ''} en ${y}`);

    const chart = document.getElementById('month-chart');
    const TRACK = 90; // hauteur max d'une barre, en px
    chart.innerHTML = perMonth.map((n, i) => {
        const h = n ? Math.max(6, Math.round(n / max * TRACK)) : 3;
        return `
        <div class="month-col" title="${MONTHS_FR[i]} : ${n} livre(s)">
          <div class="month-val">${n || ''}</div>
          <div class="month-bar${n ? '' : ' zero'}" style="height:${h}px"></div>
          <div class="month-lbl">${MONTHS_FR[i][0]}</div>
        </div>`;
    }).join('');

    // Série de mois consécutifs avec au moins une lecture, jusqu'au mois courant
    const streak = document.getElementById('streak-info');
    const curMonth = new Date().getMonth();
    let run = 0;
    for (let m = curMonth; m >= 0; m--) {
        if (perMonth[m] > 0) run++; else break;
    }
    streak.innerHTML = run >= 2
        ? `<div class="streak-badge">🔥 ${run} mois de lecture d'affilée</div>`
        : (finished.length
            ? `<div style="font-size:12px;color:var(--ink3);margin-top:8px">Lisez ce mois-ci et le prochain pour lancer une série.</div>`
            : `<div style="font-size:12px;color:var(--ink3);margin-top:8px">Marquez des livres comme « lus » pour voir votre activité mensuelle.</div>`);
}

function renderGenreChart(list, containerId, color) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const genres = {};
    list.forEach(b => { if (b.genre) genres[b.genre] = (genres[b.genre] || 0) + 1; });
    const sorted = Object.entries(genres).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const max = sorted[0]?.[1] || 1;
    if (!sorted.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<div style="font-size:11px;color:var(--ink3);text-transform:uppercase;letter-spacing:.06em;margin:16px 0 8px">Top genres lus</div>` +
        sorted.map(([g, n]) => `
            <div class="chart-bar-item">
              <div class="chart-bar-label">${esc(g.split(' ')[0])}</div>
              <div class="chart-bar-track"><div class="chart-bar-fill" style="width:${Math.round(n / max * 100)}%;background:${color}"></div></div>
              <div class="chart-bar-val">${n}</div>
            </div>`).join('');
}

// ── MODALE LIVRE ──────────────────────────────────────────────────────────
function openModal(id) {
    editId = id || null;
    const b = id ? books.find(x => x.id === id) : null;

    currentStatus = b ? b.status : 'read';
    currentEmoji = b ? (b.emoji || '📕') : '📕';
    currentRating = b ? (b.rating || 0) : 0;
    currentCover = b ? (b.cover || '') : '';

    document.getElementById('modal-title').textContent = b ? 'Modifier le livre' : 'Ajouter un roman';
    document.getElementById('save-btn').textContent = b ? 'Enregistrer' : 'Ajouter le livre';
    val('f-title', b ? b.title : '');
    val('f-author', b ? b.author : '');
    val('f-pages', b && b.pages ? b.pages : '');
    val('f-genre', b ? b.genre : '');
    val('f-year', b && b.year ? b.year : '');
    val('f-notes', b ? b.notes : '');
    val('f-isbn', b ? b.isbn : '');
    val('f-progress', b && b.progress ? b.progress : '');
    val('f-series', b ? b.series : '');
    val('f-seriesnum', b && (b.seriesNum || b.seriesNum === 0) ? b.seriesNum : '');
    document.getElementById('f-favorite').checked = b ? !!b.favorite : false;
    currentQuotes = b && Array.isArray(b.quotes) ? b.quotes.map(q => ({ ...q })) : [];
    renderQuoteEditor();
    val('f-cover', currentCover);
    updateCoverPreview();

    document.querySelectorAll('.status-tab').forEach(t => t.classList.toggle('sel', t.dataset.val === currentStatus));
    document.querySelectorAll('.emoji-opt').forEach(e => e.classList.toggle('sel', e.dataset.e === currentEmoji));
    setRatingDisplay(currentRating);

    document.getElementById('overlay').classList.add('open');
    setTimeout(() => document.getElementById('f-title').focus(), 60);
}

function val(id, v) { const el = document.getElementById(id); if (el) el.value = v == null ? '' : v; }
function get(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }

function closeModal(e) { if (e.target === document.getElementById('overlay')) closeModalDirect(); }
function closeModalDirect() { document.getElementById('overlay').classList.remove('open'); }

function selectStatus(s) {
    currentStatus = s;
    document.querySelectorAll('.status-tab').forEach(t => t.classList.toggle('sel', t.dataset.val === s));
}

function selectEmoji(el) {
    currentEmoji = el.dataset.e;
    document.querySelectorAll('.emoji-opt').forEach(e => e.classList.remove('sel'));
    el.classList.add('sel');
    updateCoverPreview();
}

// ── CITATIONS (dans la modale) ────────────────────────────────────────────
function renderQuoteEditor() {
    const box = document.getElementById('quotes-list');
    if (!box) return;
    if (!currentQuotes.length) {
        box.innerHTML = '<div class="quotes-empty">Aucune citation pour l\'instant.</div>';
        return;
    }
    box.innerHTML = currentQuotes.map((q, i) => `
      <div class="quote-item">
        <div class="quote-text">« ${esc(q.text)} »${q.page ? ` <span class="quote-page">p. ${q.page}</span>` : ''}</div>
        <button type="button" class="quote-del" title="Supprimer" onclick="removeQuote(${i})">🗑</button>
      </div>`).join('');
}

function addQuote() {
    const text = get('q-text');
    if (!text) { showToast('⚠️ Écrivez la citation avant de l\'ajouter.'); return; }
    const page = parseInt(get('q-page')) || null;
    currentQuotes.push({ text, page });
    val('q-text', ''); val('q-page', '');
    renderQuoteEditor();
}

function removeQuote(i) {
    currentQuotes.splice(i, 1);
    renderQuoteEditor();
}

function setRating(n) { currentRating = n; setRatingDisplay(n); }
function setRatingDisplay(n) {
    document.querySelectorAll('#star-picker .star').forEach(s => {
        const r = parseInt(s.dataset.r);
        s.textContent = n >= r ? '★' : (n >= r - 0.5 ? '⯨' : '☆');
        s.classList.toggle('filled', n >= r - 0.5);
    });
    const lbl = document.getElementById('rating-val');
    if (lbl) lbl.textContent = n ? '— ' + starStr(n) : '';
}

// Rendu compact d'une note en étoiles (avec demi et vides), pour cartes/listes
function starStr(n) {
    const full = Math.floor(n);
    const half = (n - full) >= 0.5;
    return '★'.repeat(full) + (half ? '⯨' : '') + '☆'.repeat(5 - full - (half ? 1 : 0));
}

// Clic sur les étoiles : moitié gauche = demi-note, moitié droite = note pleine
function initStarPicker() {
    const picker = document.getElementById('star-picker');
    if (!picker || picker._bound) return;
    picker._bound = true;
    picker.querySelectorAll('.star').forEach(star => {
        star.addEventListener('click', e => {
            const r = parseInt(star.dataset.r);
            const rect = star.getBoundingClientRect();
            const half = (e.clientX - rect.left) < rect.width / 2;
            setRating(half ? r - 0.5 : r);
        });
    });
}

function updateCoverPreview() {
    const raw = get('f-cover');
    currentCover = safeCoverUrl(raw);
    if (raw && !currentCover) showToast('⚠️ Adresse de couverture ignorée (seules les images https ou importées sont acceptées).');
    const box = document.getElementById('cover-preview');
    box.innerHTML = currentCover
        ? `<img src="${esc(currentCover)}" alt="Aperçu de la couverture" onerror="this.parentElement.textContent='${currentEmoji}'">`
        : currentEmoji;
}

function clearCover() { val('f-cover', ''); updateCoverPreview(); }

async function uploadCover(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
        const dataUrl = await shrinkImage(file, 420, 640);
        val('f-cover', dataUrl);
        updateCoverPreview();
        showToast('🖼️ Couverture importée.');
    } catch (e) {
        showToast('⚠️ Image illisible.');
    }
    input.value = '';
}

function shrinkImage(file, maxW, maxH) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => {
            const img = new Image();
            img.onload = () => {
                const ratio = Math.min(maxW / img.width, maxH / img.height, 1);
                const c = document.createElement('canvas');
                c.width = Math.round(img.width * ratio);
                c.height = Math.round(img.height * ratio);
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                res(c.toDataURL('image/jpeg', 0.82));
            };
            img.onerror = rej;
            img.src = r.result;
        };
        r.onerror = rej;
        r.readAsDataURL(file);
    });
}

async function findCoverForForm() {
    const t = get('f-title'), a = get('f-author'), i = get('f-isbn');
    if (!t && !i) { showToast('⚠️ Renseignez d\'abord un titre ou un ISBN.'); return; }
    showToast('🔎 Recherche de la couverture…');
    const data = i ? await lookupIsbn(normIsbn(i), true) : await searchOne(t + ' ' + a);
    if (data && (data.cover || data.coverAlt)) {
        val('f-cover', data.cover || data.coverAlt);
        if (!get('f-pages') && data.pages) val('f-pages', data.pages);
        if (!get('f-author') && data.authors) val('f-author', data.authors);
        if (!get('f-isbn') && data.isbn) val('f-isbn', data.isbn);
        updateCoverPreview();
        showToast('🖼️ Couverture trouvée.');
    } else {
        showToast('😕 Aucune couverture trouvée pour ce livre.');
    }
}

// Détermine la date de fin de lecture : posée quand un livre passe en « lu »,
// conservée s'il l'était déjà, effacée sinon.
function computeFinishedAt(prev, status) {
    if (status !== 'read') return null;
    if (prev && prev.status === 'read' && prev.finishedAt) return prev.finishedAt;
    return Date.now();
}

function saveBook() {
    const title = get('f-title');
    if (!title) { showToast('⚠️ Le titre est obligatoire.'); return; }
    const prev = editId ? books.find(b => b.id === editId) : null;
    const book = migrate({
        id: editId || uid(),
        title,
        author: get('f-author'),
        pages: parseInt(get('f-pages')) || 0,
        genre: get('f-genre'),
        year: parseInt(get('f-year')) || null,
        notes: get('f-notes'),
        isbn: normIsbn(get('f-isbn')),
        cover: get('f-cover'),
        coverAlt: prev ? prev.coverAlt : '',
        progress: parseInt(get('f-progress')) || 0,
        status: currentStatus,
        emoji: currentEmoji,
        rating: currentRating,
        favorite: document.getElementById('f-favorite').checked,
        series: get('f-series'),
        seriesNum: get('f-seriesnum') !== '' ? (parseFloat(get('f-seriesnum')) || null) : null,
        quotes: currentQuotes,
        finishedAt: computeFinishedAt(prev, currentStatus),
        addedAt: prev ? prev.addedAt : Date.now(),
    });

    if (editId) {
        books = books.map(b => b.id === editId ? book : b);
        showToast('✅ Livre modifié.');
    } else {
        books.unshift(book);
        showToast('📚 Livre ajouté.');
    }

    saveNow();
    closeModalDirect();
    renderAll();
    if (!book.cover && !book.isbn) autoFindCover(book.id);
}

// Recherche silencieuse d'une couverture pour un livre saisi à la main
async function autoFindCover(id) {
    const b = books.find(x => x.id === id);
    if (!b || b.cover) return;
    const data = await searchOne(b.title + ' ' + (b.author || ''));
    if (!data) return;
    const cur = books.find(x => x.id === id);
    if (!cur || cur.cover) return;
    cur.cover = data.cover || '';
    cur.coverAlt = data.coverAlt || '';
    if (!cur.isbn && data.isbn) cur.isbn = data.isbn;
    if (!cur.pages && data.pages) cur.pages = data.pages;
    save();
    renderAll();
}

// ── ACTIONS ───────────────────────────────────────────────────────────────
function editBook(id) { openModal(id); }

function deleteBook(id) {
    const b = books.find(x => x.id === id);
    if (!confirm(`Supprimer « ${b ? b.title : 'ce livre'} » ?`)) return;
    books = books.filter(x => x.id !== id);
    saveNow();
    renderAll();
    showToast('🗑 Livre supprimé.');
}

function markAs(id, status) {
    books = books.map(b => {
        if (b.id !== id) return b;
        return { ...b, status, finishedAt: computeFinishedAt(b, status) };
    });
    saveNow();
    renderAll();
    showToast({
        read: '✅ Marqué comme lu.', reading: '📖 Lecture commencée.',
        pal: '📚 Ajouté à la PAL.', wish: '⭐ Ajouté aux envies.'
    }[status]);
}

function toggleFavorite(id, ev) {
    if (ev) ev.stopPropagation();
    const b = books.find(x => x.id === id);
    if (!b) return;
    b.favorite = !b.favorite;
    saveNow();
    renderAll();
    showToast(b.favorite ? '❤️ Ajouté aux favoris.' : '🤍 Retiré des favoris.');
}

// ── GLISSER-DÉPOSER (PAL) ─────────────────────────────────────────────────
function onDragStart(e, id) { dragSrcId = id; e.dataTransfer.effectAllowed = 'move'; }

function onDrop(e) {
    e.preventDefault();
    const target = e.target.closest('.book-list-item');
    if (!target || !dragSrcId) return;
    target.classList.remove('drag-over');
    const targetId = target.id.replace('item-', '');
    if (targetId === dragSrcId) return;
    const srcIdx = books.findIndex(b => b.id === dragSrcId);
    const tgtIdx = books.findIndex(b => b.id === targetId);
    if (srcIdx < 0 || tgtIdx < 0) return;
    const [moved] = books.splice(srcIdx, 1);
    books.splice(tgtIdx, 0, moved);
    saveNow();
    renderAll();
    dragSrcId = null;
}

// ── SAUVEGARDE / RESTAURATION ─────────────────────────────────────────────
function download(name, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function stamp() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function exportJSON() {
    download(`bibliotheque-${stamp()}.json`, JSON.stringify(payload(), null, 2), 'application/json');
    showToast('⬇️ Sauvegarde téléchargée.');
}

function exportCSV() {
    const cols = ['title', 'author', 'pages', 'genre', 'year', 'status', 'rating', 'isbn', 'progress', 'notes'];
    const head = ['Titre', 'Auteur', 'Pages', 'Genre', 'Année', 'Statut', 'Note', 'ISBN', 'Page actuelle', 'Notes'];
    const esc2 = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const csv = [head.join(';')].concat(
        books.map(b => cols.map(c => esc2(c === 'status' ? statusLabel(b[c]) : b[c])).join(';'))
    ).join('\r\n');
    download(`bibliotheque-${stamp()}.csv`, '\ufeff' + csv, 'text/csv;charset=utf-8');
    showToast('📄 Export CSV téléchargé.');
}

function importJSON(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
        const parsed = parsePayload(r.result);
        if (!parsed) { showToast('⚠️ Fichier de sauvegarde illisible.'); return; }
        const incoming = parsed.books.map(migrate);
        const mode = confirm(
            `${incoming.length} livre(s) dans la sauvegarde.\n\nOK = fusionner avec la bibliothèque actuelle\nAnnuler = remplacer entièrement`);
        if (mode) {
            const keys = new Set(books.map(bookKey));
            incoming.forEach(b => { if (!keys.has(bookKey(b))) { books.push(b); keys.add(bookKey(b)); } });
        } else {
            books = incoming;
        }
        saveNow();
        renderAll();
        showToast(`⬆️ ${incoming.length} livre(s) restaurés.`);
    };
    r.readAsText(file);
    input.value = '';
}

function bookKey(b) {
    return (b.isbn || (b.title + '|' + b.author)).toLowerCase().replace(/\s+/g, ' ').trim();
}

function loadSample() {
    const y = new Date().getFullYear();
    const fin = (mois) => new Date(y, mois, 12).getTime(); // date de fin de lecture cette année
    const S = (o) => migrate(Object.assign({ id: uid(), addedAt: Date.now() }, o));
    books = [
        S({ title: 'Le Rouge et le Noir', author: 'Stendhal', pages: 503, genre: 'Classique', status: 'read', emoji: '📕', rating: 5, isbn: '9782070413003', year: y, finishedAt: fin(0), favorite: true, quotes: [{ text: 'Le roman est un miroir que l\'on promène le long d\'un chemin.', page: 342 }] }),
        S({ title: 'Dune', author: 'Frank Herbert', pages: 688, genre: 'Science-fiction', status: 'read', emoji: '🌊', rating: 4.5, isbn: '9782266320481', year: y, finishedAt: fin(1), series: 'Le Cycle de Dune', seriesNum: 1, favorite: true }),
        S({ title: 'Les Misérables', author: 'Victor Hugo', pages: 1232, genre: 'Classique', status: 'read', emoji: '📗', rating: 5, isbn: '9782253096337', year: y, finishedAt: fin(3) }),
        S({ title: 'Le Messie de Dune', author: 'Frank Herbert', pages: 350, genre: 'Science-fiction', status: 'pal', emoji: '🏜️', isbn: '9782266133302', series: 'Le Cycle de Dune', seriesNum: 2 }),
        S({ title: 'Fondation', author: 'Isaac Asimov', pages: 372, genre: 'Science-fiction', status: 'pal', emoji: '🔮', isbn: '9782070415717' }),
        S({ title: 'La Horde du Contrevent', author: 'Alain Damasio', pages: 736, genre: 'Science-fiction', status: 'reading', emoji: '🏔️', isbn: '9782070348909', progress: 300 }),
        S({ title: 'Le Nom de la Rose', author: 'Umberto Eco', pages: 502, genre: 'Roman policier', status: 'wish', emoji: '🗡️', isbn: '9782253033134' }),
        S({ title: '1984', author: 'George Orwell', pages: 328, genre: 'Science-fiction', status: 'wish', emoji: '📘', isbn: '9782072862496' }),
    ].concat(books);
    if (!settings.challengeGoal) { settings.challengeGoal = 20; saveSettings(); }
    saveNow();
    renderAll();
    showToast('📚 Exemples chargés.');
}

// ── UTILITAIRES ───────────────────────────────────────────────────────────
function set(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function statusLabel(s) {
    return { read: 'Lu', reading: 'En cours', pal: 'PAL', wish: 'Envie' }[s] || s;
}

function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._tm);
    t._tm = setTimeout(() => t.classList.remove('show'), 2800);
}

function normIsbn(raw) {
    const c = String(raw || '').replace(/[^0-9Xx]/g, '').toUpperCase();
    return (c.length === 10 || c.length === 13) ? c : '';
}

function findByIsbn(isbn) { return books.find(b => b.isbn && b.isbn === isbn); }

// ── RECHERCHE DE LIVRES (Google Books + Open Library) ──────────────────────
function httpsify(u) { return String(u || '').replace(/^http:/, 'https:').replace(/&edge=curl/, ''); }

async function jsonFetch(url, ms = 9000) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), ms);
    try {
        const r = await fetch(url, { signal: ctl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
    } finally { clearTimeout(to); }
}

function fromGoogleVolume(info, isbn) {
    const il = info.imageLinks || {};
    const cover = httpsify(il.extraLarge || il.large || il.medium || il.thumbnail || il.smallThumbnail || '');
    const ids = info.industryIdentifiers || [];
    const found = (ids.find(i => i.type === 'ISBN_13') || ids.find(i => i.type === 'ISBN_10') || {}).identifier;
    return {
        title: info.title + (info.subtitle ? ' — ' + info.subtitle : ''),
        authors: (info.authors || []).join(', '),
        pages: info.pageCount || 0,
        year: info.publishedDate ? parseInt(info.publishedDate.slice(0, 4)) || null : null,
        isbn: isbn || normIsbn(found) || '',
        cover,
        coverAlt: '',
        subjects: (info.categories || []).join(', '),
        publisher: info.publisher || ''
    };
}

async function googleByIsbn(isbn) {
    for (const suffix of ['&country=FR', '']) {
        try {
            const d = await jsonFetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}${suffix}`);
            if (d.items && d.items.length) return fromGoogleVolume(d.items[0].volumeInfo, isbn);
            return null;
        } catch (e) { /* on retente sans country */ }
    }
    return null;
}

async function openLibByIsbn(isbn) {
    try {
        const d = await jsonFetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
        const b = d['ISBN:' + isbn];
        if (!b) return null;
        return {
            title: b.title || '',
            authors: (b.authors || []).map(a => a.name).join(', '),
            pages: b.number_of_pages || 0,
            year: b.publish_date ? (parseInt(String(b.publish_date).match(/\d{4}/)) || null) : null,
            isbn,
            cover: httpsify(b.cover ? (b.cover.large || b.cover.medium || b.cover.small || '') : ''),
            coverAlt: '',
            subjects: (b.subjects || []).slice(0, 4).map(s => s.name || s).join(', '),
            publisher: (b.publishers || []).map(p => p.name || p).join(', ')
        };
    } catch (e) { return null; }
}

// Fusionne les deux sources : on garde le champ le plus complet de chacune
async function lookupIsbn(isbn, silent) {
    if (!isbn) return null;
    if (!silent) {
        document.getElementById('scan-loading').style.display = 'block';
        document.getElementById('scan-result').style.display = 'none';
        document.getElementById('scan-error').style.display = 'none';
    }
    let g = null, o = null;
    try {
        [g, o] = await Promise.all([
            googleByIsbn(isbn).catch(() => null),
            openLibByIsbn(isbn).catch(() => null)
        ]);
    } catch (e) { }
    if (!silent) document.getElementById('scan-loading').style.display = 'none';

    if (!g && !o) {
        if (!silent) showScanError(`Aucun livre trouvé pour l'ISBN ${isbn}. Ajoutez-le à la main, ou cherchez-le par titre.`);
        return null;
    }
    const pick = (a, b) => (a && String(a).length ? a : (b || ''));
    const data = {
        title: pick(g && g.title, o && o.title),
        authors: pick(g && g.authors, o && o.authors),
        pages: (g && g.pages) || (o && o.pages) || 0,
        year: (g && g.year) || (o && o.year) || null,
        isbn,
        cover: pick(o && o.cover, g && g.cover),
        coverAlt: (g && g.cover && o && o.cover) ? g.cover : '',
        subjects: pick(g && g.subjects, o && o.subjects),
        publisher: pick(g && g.publisher, o && o.publisher)
    };
    if (!data.cover) data.cover = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`;
    return data;
}

async function searchTitle(q, limit = 8) {
    for (const suffix of ['&country=FR', '']) {
        try {
            const d = await jsonFetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=${limit}${suffix}`);
            if (d.items && d.items.length) return d.items.map(it => fromGoogleVolume(it.volumeInfo, ''));
            break;
        } catch (e) { }
    }
    try { // repli Open Library
        const d = await jsonFetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=${limit}&fields=title,author_name,number_of_pages_median,first_publish_year,isbn,cover_i`);
        return (d.docs || []).map(doc => ({
            title: doc.title || '',
            authors: (doc.author_name || []).join(', '),
            pages: doc.number_of_pages_median || 0,
            year: doc.first_publish_year || null,
            isbn: normIsbn((doc.isbn || [])[0] || ''),
            cover: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : '',
            coverAlt: '', subjects: '', publisher: ''
        }));
    } catch (e) { return []; }
}

async function searchOne(q) {
    const r = await searchTitle(q, 3);
    return r && r.length ? r[0] : null;
}

const GENRE_MAP = [
    ['Roman policier', ['polic', 'detective', 'mystery', 'crime', 'enquête']],
    ['Thriller', ['thriller', 'suspense']],
    ['Fantasy', ['fantasy', 'fantastique', 'magic']],
    ['Science-fiction', ['science fiction', 'science-fiction', 'anticipation', 'dystop']],
    ['Romance', ['romance', 'sentimental', 'love stories']],
    ['Historique', ['histor', 'histoire']],
    ['Horreur', ['horror', 'horreur', 'terreur']],
    ['Biographie', ['biograph', 'autobiograph', 'mémoires', 'memoir']],
    ['Manga / BD', ['manga', 'comics', 'bande dessinée', 'graphic novel']],
    ['Jeunesse', ['juvenile', 'jeunesse', 'young adult', 'enfant']],
    ['Aventure', ['adventure', 'aventure']],
    ['Classique', ['classic', 'classique']],
    ['Littérature générale', ['fiction', 'littérature', 'literature', 'roman']],
];

function guessGenre(subjects) {
    const s = String(subjects || '').toLowerCase();
    if (!s) return '';
    for (const [genre, keys] of GENRE_MAP) if (keys.some(k => s.includes(k))) return genre;
    return '';
}

// ── SCANNER ───────────────────────────────────────────────────────────────
let scanStream = null, scanReader = null, scanControls = null;
let scanLoop = null, quaggaOn = false, cameraOn = false;
let scannedBookData = null;
let lastCode = '', lastCodeAt = 0;
let zxingPromise = null;

function toggleToolsMenu(e) {
    if (e) e.stopPropagation();
    document.getElementById('tools-menu').classList.toggle('open');
}
function closeToolsMenu() {
    document.getElementById('tools-menu').classList.remove('open');
}

// ── THÈME (clair / sombre) ────────────────────────────────────────────────
function applyTheme(theme) {
    const dark = theme === 'dark';
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#171016' : '#2c2a63');
    document.querySelectorAll('.theme-btn').forEach(b => {
        b.textContent = dark ? '☀️ Mode clair' : '🌙 Mode sombre';
    });
}
function toggleTheme() {
    settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
    applyTheme(settings.theme);
    saveSettings();
}

function openScanModal() {
    document.getElementById('scan-overlay').classList.add('open');
    resetScan();
    setScanMode('cam');
    document.getElementById('scan-log').innerHTML = '';
}

function closeScanModal(e) { if (e.target === document.getElementById('scan-overlay')) closeScanModalDirect(); }

function closeScanModalDirect() {
    stopCamera();
    document.getElementById('scan-overlay').classList.remove('open');
}

function setScanMode(mode) {
    ['cam', 'photo', 'isbn', 'title'].forEach(m => {
        document.getElementById('scan-view-' + m).style.display = m === mode ? 'block' : 'none';
        document.getElementById('stab-' + m).classList.toggle('sel', m === mode);
    });
    if (mode !== 'cam') stopCamera();
    document.getElementById('scan-error').style.display = 'none';
    if (mode === 'isbn') setTimeout(() => document.getElementById('isbn-input').focus(), 60);
    if (mode === 'title') setTimeout(() => document.getElementById('title-input').focus(), 60);
}

function engineLabel(t) { const el = document.getElementById('scan-engine'); if (el) el.textContent = t; }

function toggleCamera() { cameraOn ? stopCamera() : startCamera(); }

async function startCamera() {
    const video = document.getElementById('scan-video');
    document.getElementById('scan-error').style.display = 'none';

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showScanError("La caméra n'est pas disponible ici. Ouvrez la page via https:// (ou localhost), ou utilisez l'onglet Photo / ISBN.");
        return;
    }

    try {
        scanStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        });
    } catch (err) {
        const msg = err && err.name === 'NotAllowedError'
            ? "Accès à la caméra refusé. Autorisez la caméra dans les réglages du navigateur, puis réessayez."
            : "Caméra inaccessible (" + (err && err.name || 'erreur') + "). Utilisez l'onglet Photo pour décoder une image, ou saisissez l'ISBN.";
        showScanError(msg);
        return;
    }

    video.srcObject = scanStream;
    video.setAttribute('playsinline', 'true');
    try { await video.play(); } catch (e) { }
    cameraOn = true;
    document.getElementById('cam-btn').textContent = '⏹ Arrêter la caméra';
    setupTorch();

    if ('BarcodeDetector' in window) {
        try {
            const supported = await window.BarcodeDetector.getSupportedFormats();
            const formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e'].filter(f => supported.includes(f));
            if (formats.length) {
                const detector = new window.BarcodeDetector({ formats });
                engineLabel('détection native');
                scanLoop = setInterval(async () => {
                    if (!cameraOn || video.readyState < 2) return;
                    try {
                        const codes = await detector.detect(video);
                        if (codes && codes.length) onCodeDetected(codes[0].rawValue);
                    } catch (e) { }
                }, 250);
                return;
            }
        } catch (e) { }
    }

    const ok = await startZXing(video);
    if (ok) return;
    startQuagga();
}

function loadScript(src) {
    return new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = src; s.async = true;
        s.onload = () => res(true);
        s.onerror = () => rej(new Error('échec ' + src));
        document.head.appendChild(s);
    });
}

async function ensureZXing() {
    if (window.ZXingBrowser || window.ZXing) return true;
    if (zxingPromise) return zxingPromise;
    zxingPromise = (async () => {
        const sources = [
            'https://unpkg.com/@zxing/browser@0.1.5/umd/zxing-browser.min.js',
            'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/zxing-browser.min.js',
            'https://unpkg.com/@zxing/library@0.20.0/umd/index.min.js',
            'https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/umd/index.min.js',
        ];
        for (const s of sources) {
            try { await loadScript(s); if (window.ZXingBrowser || window.ZXing) return true; } catch (e) { }
        }
        return false;
    })();
    return zxingPromise;
}

function newZXingReader() {
    const NS = window.ZXingBrowser || window.ZXing;
    if (NS && NS.BrowserMultiFormatReader) return new NS.BrowserMultiFormatReader();
    return null;
}

async function startZXing(video) {
    engineLabel('chargement du décodeur…');
    const ready = await ensureZXing();
    if (!ready) return false;
    const reader = newZXingReader();
    if (!reader) return false;
    scanReader = reader;
    try {
        const cb = (result) => { if (result) onCodeDetected(result.getText ? result.getText() : result.text); };
        const ret = reader.decodeFromVideoElement
            ? reader.decodeFromVideoElement(video, cb)
            : reader.decodeFromVideoElementContinuously(video, cb);
        if (ret && typeof ret.then === 'function') scanControls = await ret; else scanControls = ret;
        engineLabel('décodeur ZXing');
        return true;
    } catch (e) {
        return false;
    }
}

function startQuagga() {
    if (typeof Quagga === 'undefined') {
        engineLabel('lecture auto indisponible');
        showScanError("Le lecteur automatique n'a pas pu se charger (connexion ?). Utilisez l'onglet Photo, ISBN ou Titre.");
        return;
    }
    engineLabel('décodeur Quagga');
    document.getElementById('scan-video').style.display = 'none';
    Quagga.init({
        inputStream: {
            name: 'Live', type: 'LiveStream',
            target: document.getElementById('scan-frame'),
            constraints: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' }
        },
        locator: { patchSize: 'medium', halfSample: true },
        numOfWorkers: navigator.hardwareConcurrency ? Math.min(4, navigator.hardwareConcurrency) : 2,
        frequency: 10,
        decoder: { readers: ['ean_reader', 'ean_8_reader', 'upc_reader'] },
        locate: true
    }, err => {
        if (err) { showScanError('Caméra indisponible : ' + err.message); return; }
        Quagga.start();
        quaggaOn = true;
    });
    if (!Quagga._biblioBound) {
        Quagga.onDetected(r => {
            const code = r && r.codeResult && r.codeResult.code;
            if (code) onCodeDetected(code);
        });
        Quagga._biblioBound = true;
    }
}

function setupTorch() {
    const btn = document.getElementById('torch-btn');
    btn.style.display = 'none';
    const track = scanStream && scanStream.getVideoTracks()[0];
    if (!track || !track.getCapabilities) return;
    try {
        const caps = track.getCapabilities();
        if (caps && caps.torch) btn.style.display = 'block';
    } catch (e) { }
}

let torchOn = false;
async function toggleTorch() {
    const track = scanStream && scanStream.getVideoTracks()[0];
    if (!track) return;
    try {
        torchOn = !torchOn;
        await track.applyConstraints({ advanced: [{ torch: torchOn }] });
    } catch (e) { showToast("La lampe n'est pas pilotable sur cet appareil."); }
}

function stopCamera() {
    cameraOn = false;
    clearInterval(scanLoop); scanLoop = null;
    if (scanControls && scanControls.stop) { try { scanControls.stop(); } catch (e) { } }
    scanControls = null;
    if (scanReader && scanReader.reset) { try { scanReader.reset(); } catch (e) { } }
    scanReader = null;
    if (quaggaOn) { try { Quagga.stop(); } catch (e) { } quaggaOn = false; }
    document.querySelectorAll('#scan-frame video:not(#scan-video), #scan-frame canvas').forEach(el => el.remove());
    if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
    const v = document.getElementById('scan-video');
    if (v) { v.srcObject = null; v.style.display = 'block'; }
    torchOn = false;
    const btn = document.getElementById('cam-btn');
    if (btn) btn.textContent = '▶️ Démarrer la caméra';
    const tb = document.getElementById('torch-btn');
    if (tb) tb.style.display = 'none';
    engineLabel('prêt');
}

function beep() {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = 880;
        g.gain.setValueAtTime(0.09, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
        o.connect(g); g.connect(ctx.destination);
        o.start(); o.stop(ctx.currentTime + 0.17);
        setTimeout(() => ctx.close(), 400);
    } catch (e) { }
    if (navigator.vibrate) { try { navigator.vibrate(70); } catch (e) { } }
}

// Cœur du scan : un code lu → recherche → enregistrement
async function onCodeDetected(raw) {
    const isbn = normIsbn(raw);
    if (!isbn) return;                                  // code-barres qui n'est pas un ISBN
    const now = Date.now();
    if (isbn === lastCode && now - lastCodeAt < 5000) return;
    lastCode = isbn; lastCodeAt = now;
    beep();

    const dup = findByIsbn(isbn);
    if (dup) {
        addScanLog(dup, 'déjà dans la bibliothèque');
        showToast(`📗 « ${dup.title} » est déjà dans votre bibliothèque.`);
        return;
    }

    const auto = document.getElementById('scan-auto').checked;
    engineLabel('recherche du livre…');
    const data = await lookupIsbn(isbn, true);
    engineLabel(cameraOn ? 'scan en cours' : 'prêt');

    if (!data) {
        showScanError(`ISBN ${isbn} lu, mais introuvable dans les catalogues. Cherchez-le par titre ou saisissez-le à la main.`);
        return;
    }

    if (auto) {
        const b = addBookFromData(data, document.getElementById('scan-status').value);
        addScanLog(b, 'ajouté');
        showToast(`📚 « ${b.title} » enregistré.`);
    } else {
        scannedBookData = data;
        stopCamera();
        showScanResult(data);
    }
}

function addScanLog(b, note) {
    const log = document.getElementById('scan-log');
    const div = document.createElement('div');
    div.className = 'scan-log-item';
    div.innerHTML = `${coverImg(b, '', `<span style="font-size:20px">${b.emoji || '📕'}</span>`)}
              <div style="flex:1;min-width:0">
                <div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(b.title)}</div>
                <div style="color:var(--ink3);font-size:11px">${esc(note)}</div>
              </div>`;
    log.prepend(div);
}

function addBookFromData(d, status) {
    const b = migrate({
        id: uid(),
        title: d.title || 'Sans titre',
        author: d.authors || '',
        pages: d.pages || 0,
        genre: guessGenre(d.subjects),
        year: status === 'read' ? new Date().getFullYear() : null,
        isbn: d.isbn || '',
        cover: d.cover || '',
        coverAlt: d.coverAlt || '',
        status: status || 'pal',
        emoji: '📕',
        notes: d.publisher ? 'Éditeur : ' + d.publisher : '',
        addedAt: Date.now()
    });
    books.unshift(b);
    saveNow();
    renderAll();
    return b;
}

// Photo → décodage local
async function decodeFromPhoto(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    document.getElementById('scan-error').style.display = 'none';
    document.getElementById('scan-loading').style.display = 'block';
    let code = null;
    try {
        const bitmap = await createImageBitmap(file);
        if ('BarcodeDetector' in window) {
            try {
                const supported = await window.BarcodeDetector.getSupportedFormats();
                const formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e'].filter(f => supported.includes(f));
                const det = new window.BarcodeDetector(formats.length ? { formats } : undefined);
                const res = await det.detect(bitmap);
                if (res && res.length) code = res[0].rawValue;
            } catch (e) { }
        }
        if (!code && await ensureZXing()) {
            const reader = newZXingReader();
            const c = document.createElement('canvas');
            c.width = bitmap.width; c.height = bitmap.height;
            c.getContext('2d').drawImage(bitmap, 0, 0);
            try {
                const r = reader.decodeFromCanvas(c);
                if (r) code = r.getText ? r.getText() : r.text;
            } catch (e) { }
        }
    } catch (e) { }
    document.getElementById('scan-loading').style.display = 'none';
    if (!code) {
        showScanError("Code-barres illisible sur cette photo. Reprenez-la de près, bien éclairée et sans reflet — ou saisissez l'ISBN.");
        return;
    }
    lastCode = '';
    onCodeDetected(code);
}

// Saisie manuelle
async function fetchByIsbn() {
    const isbn = normIsbn(document.getElementById('isbn-input').value);
    if (!isbn) { showScanError("L'ISBN doit contenir 10 ou 13 chiffres."); return; }
    const dup = findByIsbn(isbn);
    if (dup) { showScanError(`« ${dup.title} » est déjà dans votre bibliothèque.`); return; }
    const data = await lookupIsbn(isbn, false);
    if (!data) return;
    if (document.getElementById('scan-auto').checked) {
        const b = addBookFromData(data, document.getElementById('scan-status').value);
        addScanLog(b, 'ajouté');
        showToast(`📚 « ${b.title} » enregistré.`);
        document.getElementById('isbn-input').value = '';
    } else {
        scannedBookData = data;
        showScanResult(data);
    }
}

// Recherche par titre
async function searchByTitle() {
    const q = document.getElementById('title-input').value.trim();
    if (!q) return;
    const box = document.getElementById('title-results');
    box.innerHTML = '';
    document.getElementById('scan-loading').style.display = 'block';
    document.getElementById('scan-error').style.display = 'none';
    const res = await searchTitle(q, 8);
    document.getElementById('scan-loading').style.display = 'none';
    if (!res || !res.length) { showScanError('Aucun résultat pour cette recherche.'); return; }
    window._titleResults = res;
    box.innerHTML = res.map((r, i) => `
              <button class="search-res-item" onclick="pickTitleResult(${i})">
        ${r.cover ? `<img src="${esc(r.cover)}" alt="" class="cover-thumb">` : '<div class="cover-thumb-fb">📕</div>'}
        <div style="flex:1;min-width:0">
          <div style="font-family:'Playfair Display',serif;font-weight:600;font-size:14px">${esc(r.title)}</div>
          <div style="font-size:12px;color:var(--ink2)">${esc(r.authors || 'Auteur inconnu')}</div>
          <div style="font-size:11px;color:var(--ink3)">${[r.year, r.pages ? r.pages + ' p.' : '', r.publisher].filter(Boolean).map(esc).join(' · ')}</div>
        </div>
              </button>`).join('');
}

function pickTitleResult(i) {
    const d = (window._titleResults || [])[i];
    if (!d) return;
    scannedBookData = d;
    showScanResult(d);
    try { document.getElementById('scan-result').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { }
}

function showScanResult(b) {
    document.getElementById('scan-result').style.display = 'block';
    document.getElementById('scan-res-title').textContent = b.title || '(Titre inconnu)';
    document.getElementById('scan-res-author').textContent = b.authors ? '✍️ ' + b.authors : '';
    document.getElementById('scan-res-meta').textContent =
        [b.pages ? b.pages + ' pages' : '', b.year || '', b.publisher || '', b.isbn ? 'ISBN ' + b.isbn : '']
            .filter(Boolean).join(' · ');
    const wrap = document.getElementById('scan-cover-wrap');
    wrap.innerHTML = b.cover
        ? `<img src="${esc(b.cover)}" alt="Couverture" style="width:70px;height:100px;object-fit:cover;border-radius:5px;box-shadow:0 2px 10px rgba(0,0,0,.2)" onerror="this.parentElement.textContent='📕'">`
        : '📕';
}

function saveScannedBook() {
    if (!scannedBookData) return;
    const b = addBookFromData(scannedBookData, document.getElementById('scan-status').value);
    addScanLog(b, 'ajouté');
    showToast(`📚 « ${b.title} » enregistré.`);
    scannedBookData = null;
    document.getElementById('scan-result').style.display = 'none';
}

function importScannedBook() {
    if (!scannedBookData) return;
    const d = scannedBookData;
    closeScanModalDirect();
    openModal();
    selectStatus(document.getElementById('scan-status').value);
    val('f-title', d.title || '');
    val('f-author', d.authors || '');
    if (d.pages) val('f-pages', d.pages);
    if (d.year) val('f-year', d.year);
    val('f-isbn', d.isbn || '');
    val('f-cover', d.cover || '');
    const g = guessGenre(d.subjects);
    if (g) val('f-genre', g);
    updateCoverPreview();
    showToast('📷 Fiche pré-remplie — vérifiez puis enregistrez.');
}

function showScanError(msg) {
    const el = document.getElementById('scan-error');
    el.style.display = 'block';
    el.textContent = '⚠️ ' + msg;
    document.getElementById('scan-loading').style.display = 'none';
}

function resetScan() {
    stopCamera();
    scannedBookData = null;
    lastCode = '';
    ['scan-result', 'scan-loading', 'scan-error'].forEach(id => document.getElementById(id).style.display = 'none');
    const i = document.getElementById('isbn-input'); if (i) i.value = '';
    const t = document.getElementById('title-results'); if (t) t.innerHTML = '';
}

// ── DÉMARRAGE ─────────────────────────────────────────────────────────────
(async () => {
    if (navigator.storage && navigator.storage.persist) {
        try { await navigator.storage.persist(); } catch (e) { }
    }
    loadSettings();
    applyTheme(settings.theme);
    initStarPicker();
    await loadBooks();
    renderAll();
    markSaved();
    hideSplash();
})();

// Masque l'écran de démarrage une fois l'appli prête (min. 600 ms pour éviter un flash)
function hideSplash() {
    const sp = document.getElementById('splash');
    if (!sp) return;
    const show = () => { sp.classList.add('hide'); setTimeout(() => sp.remove(), 500); };
    setTimeout(show, 600);
}
// Filet de sécurité : masque le splash même si l'init échoue
window.addEventListener('load', () => setTimeout(() => {
    const sp = document.getElementById('splash');
    if (sp && !sp.classList.contains('hide')) { sp.classList.add('hide'); setTimeout(() => sp.remove(), 500); }
}, 2500));

// Filet de sécurité : on écrit avant toute fermeture / mise en arrière-plan
window.addEventListener('beforeunload', saveLocal);
window.addEventListener('pagehide', saveLocal);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
});

// Raccourcis clavier
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        closeModalDirect();
        if (document.getElementById('scan-overlay').classList.contains('open')) closeScanModalDirect();
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (typing) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openModal(); }
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); openScanModal(); }
    if (e.key === '/') { e.preventDefault(); document.getElementById('search-input').focus(); }
});



// ── PWA : service worker + invite d'installation ──────────────────────────
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => { /* hors-ligne ou file:// */ });
    });
}

let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstall = e;
    showInstallButton();
});

function showInstallButton() {
    if (document.getElementById('install-btn')) return;
    const nav = document.querySelector('.sidebar-tools');
    if (nav) {
        const b = document.createElement('button');
        b.id = 'install-btn';
        b.className = 'side-btn';
        b.textContent = '⬇️ Installer l\'application';
        b.onclick = triggerInstall;
        nav.prepend(b);
    }
    const menu = document.querySelector('.tools-menu-panel');
    if (menu && !document.getElementById('install-btn-m')) {
        const b2 = document.createElement('button');
        b2.id = 'install-btn-m';
        b2.className = 'side-btn';
        b2.textContent = '⬇️ Installer l\'application';
        b2.onclick = () => { triggerInstall(); closeToolsMenu(); };
        menu.insertBefore(b2, menu.children[1]);
    }
}

async function triggerInstall() {
    if (!deferredInstall) {
        showToast('Utilisez le menu du navigateur : « Ajouter à l\'écran d\'accueil ».');
        return;
    }
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch (e) { }
    deferredInstall = null;
    document.getElementById('install-btn')?.remove();
    document.getElementById('install-btn-m')?.remove();
}

window.addEventListener('appinstalled', () => {
    showToast('📲 Application installée !');
    document.getElementById('install-btn')?.remove();
    document.getElementById('install-btn-m')?.remove();
});