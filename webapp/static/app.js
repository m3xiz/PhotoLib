const state = {
  showRaw: false,
  keywords: [],
  page: 1,
  pageSize: 60,
  results: [],
  total: 0,
  currentIndex: -1, // index de la photo ouverte dans state.results
};

const el = (id) => document.getElementById(id);

async function loadStatus() {
  const body = el("status-body");
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    const last = data.last_scan;
    let scanTxt = "aucun scan enregistré";
    if (last && last.finished_at) {
      const d = new Date(last.finished_at * 1000);
      scanTxt = `dernier scan : ${d.toLocaleString("fr-BE")} (${last.files_updated} mis à jour)`;
    } else if (last && last.status === "running") {
      scanTxt = "scan en cours…";
    }
    body.innerHTML = `
      <p>${data.total_photos} photos indexées</p>
      <p>${data.total_tags} mots-clés</p>
      <p>${scanTxt}</p>`;
  } catch (e) {
    body.textContent = "Statut indisponible";
  }
}

function openStatusModal() {
  el("status-modal").classList.remove("hidden");
  loadStatus(); // toujours à jour au moment où on l'ouvre
}

function closeStatusModal() {
  el("status-modal").classList.add("hidden");
}

let suggestionsRequestId = 0;

async function loadTagSuggestions(q, show = true) {
  const requestId = ++suggestionsRequestId;
  const res = await fetch(`/api/tags?q=${encodeURIComponent(q || "")}`);
  const data = await res.json();
  // Une action plus récente (sélection, fermeture...) a eu lieu pendant que
  // cette requête était en vol : on ignore cette réponse périmée pour ne
  // pas rouvrir la liste après coup.
  if (requestId !== suggestionsRequestId) return;
  if (show) {
    renderSuggestions(data.tags);
  } else {
    hideSuggestions(); // les données sont rafraîchies mais on ne rouvre pas la liste
  }
}

function renderSuggestions(tags) {
  const box = el("keyword-suggestions");
  if (!tags || !tags.length) {
    box.innerHTML = "";
    box.classList.add("hidden");
    return;
  }
  box.innerHTML = "";
  tags.forEach((t) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "keyword-suggestion-item";
    item.textContent = t;
    // mousedown (pas click) : se déclenche AVANT le blur de l'input, sinon
    // le blur ferme la liste avant que le tap soit traité (souci fréquent
    // sur mobile/tactile). Petit flash visuel avant fermeture pour
    // confirmer quel mot-clé a été cliqué.
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      item.classList.add("keyword-suggestion-item--picked");
      setTimeout(() => selectSuggestion(t), 120);
    });
    box.appendChild(item);
  });
  box.classList.remove("hidden");
}

function hideSuggestions() {
  suggestionsRequestId++; // invalide toute réponse de fetch encore en vol
  el("keyword-suggestions").classList.add("hidden");
}

function selectSuggestion(tag) {
  if (!state.keywords.includes(tag)) {
    state.keywords.push(tag);
    renderChips();
  }
  el("keyword-input").value = "";
  hideSuggestions();
}

function renderChips() {
  const container = el("keyword-chips");
  container.innerHTML = "";
  state.keywords.forEach((kw, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `${escapeHtml(kw)} <button data-i="${i}">×</button>`;
    chip.querySelector("button").addEventListener("click", () => {
      state.keywords.splice(i, 1);
      renderChips();
    });
    container.appendChild(chip);
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function addKeywordFromInput() {
  const input = el("keyword-input");
  const val = input.value.trim();
  if (val && !state.keywords.includes(val)) {
    state.keywords.push(val);
    renderChips();
  }
  input.value = "";
  hideSuggestions();
}

async function runSearch(page = 1) {
  state.page = page;
  const keywordMode = document.querySelector('input[name="kwmode"]:checked').value;
  const exclusive = el("exclusive-checkbox").checked;
  const sort = el("sort-select").value;
  const params = new URLSearchParams({
    keywords: state.keywords.join(","),
    keyword_mode: keywordMode,
    exclusive: String(exclusive),
    sort,
    page: String(page),
    page_size: String(state.pageSize),
  });
  const dateFrom = el("date-from").value;
  const dateTo = el("date-to").value;
  const filename = el("filename-input").value.trim();
  const title = el("title-input").value.trim();
  const caption = el("caption-input").value.trim();
  if (dateFrom) params.set("date_from", dateFrom);
  if (dateTo) params.set("date_to", dateTo);
  if (filename) params.set("filename", filename);
  if (title) params.set("title", title);
  if (caption) params.set("caption", caption);
const rawChecked = el("raw-toggle").checked;
if (rawChecked) { params.set("show_raw", "on"); }

  el("results-meta").textContent = "Recherche en cours…";
  const res = await fetch(`/api/search?${params.toString()}`);
  const data = await res.json();
  renderResults(data);
}

function renderResults(data) {
  state.results = data.results;
  state.total = data.total;
  state.pageSize = data.page_size;

  el("results-meta").textContent = `${data.total} résultat(s) — page ${data.page}`;
  const grid = el("results");
  grid.innerHTML = "";
  data.results.forEach((p, i) => {
    const card = document.createElement("div");
    card.className = "photo-card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    const dateTxt = p.date_taken ? p.date_taken.slice(0, 10) : "date inconnue";
    card.innerHTML = `
      <img loading="lazy" src="${p.thumb_url || ''}" alt="${escapeHtml(p.filename)}">
      <div class="meta">
        <span class="fname">${escapeHtml(p.filename)}</span>
        <span>${dateTxt}</span>
      </div>`;
    card.addEventListener("click", () => openLightbox(p.id, i));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openLightbox(p.id, i); }
    });
    grid.appendChild(card);
  });
  renderPagination(data);
}

function renderPagination(data) {
  const totalPages = Math.max(1, Math.ceil(data.total / data.page_size));
  const container = el("pagination");
  container.innerHTML = "";
  if (totalPages <= 1) return;

  const makeBtn = (label, page, disabled = false, active = false) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = "secondary" + (active ? " active" : "");
    b.disabled = disabled;
    b.addEventListener("click", () => runSearch(page));
    return b;
  };

  container.appendChild(makeBtn("‹ Précédent", data.page - 1, data.page <= 1));
  const start = Math.max(1, data.page - 3);
  const end = Math.min(totalPages, start + 6);
  for (let p = start; p <= end; p++) {
    container.appendChild(makeBtn(String(p), p, false, p === data.page));
  }
  container.appendChild(makeBtn("Suivant ›", data.page + 1, data.page >= totalPages));
}

function resetFilters() {
  state.keywords = [];
  renderChips();
  el("keyword-input").value = "";
  loadTagSuggestions("", false);

// Popstate listener to handle back/forward navigation when lightbox is open

  el("date-from").value = "";
  el("date-to").value = "";
  el("filename-input").value = "";
  el("title-input").value = "";
  el("caption-input").value = "";
  el("exclusive-checkbox").checked = false;
  updateExclusiveState();
  el("sort-select").value = "date_desc";
  runSearch(1);
}

// Quand "Exclusif" est coché, le choix ET/OU n'a plus de sens (l'exclusivité
// implique déjà "tous ces mots-clés, et rien d'autre") -- on le désactive
// visuellement plutôt que de le laisser actif sans effet.
function updateExclusiveState() {
  const exclusive = el("exclusive-checkbox").checked;
  document.querySelectorAll('input[name="kwmode"]').forEach((r) => { r.disabled = exclusive; });
}

// --- Visionneuse plein écran (lightbox) ---
// Une seule modale réutilisée à chaque clic : jamais de nouvel onglet/fenêtre.

const FIELD_LABELS = {
  filename: "Nom de fichier",
  relpath: "Chemin",
  date_taken: "Date de prise de vue",
  title: "Titre",
  caption: "Légende",
};

// Formats que les navigateurs savent afficher nativement dans une <img>.
// Tout le reste (RAW : CR2, NEF, ARW, DNG, RAF, ORF, RW2...) n'est pas
// affichable -- on montre un message + le lien de téléchargement à la place.
const DISPLAYABLE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp"]);

function openLightbox(photoId, index) {
  state.currentIndex = index;
  updateNavButtons();
  // Push modal state to history if not already present
  if (!history.state?.modal) {
    history.pushState({ modal: true }, '');
  }

  const lightbox = el("lightbox");
  const img = el("lightbox-img");
  const unsupported = el("lightbox-unsupported");
  const infoPanel = el("lightbox-info-panel");
  const infoList = el("lightbox-info-list");
  const originalLink = el("lightbox-original-link");

  infoPanel.classList.add("hidden");
  infoList.innerHTML = "";
  img.src = "";
  img.classList.add("hidden");
  unsupported.classList.add("hidden");
  originalLink.classList.add("disabled");
  lightbox.classList.remove("hidden");
  document.body.style.overflow = "hidden"; // évite le scroll de la page derrière

  fetch(`/api/photo/${photoId}`)
    .then((res) => res.json())
    .then((p) => {
      originalLink.href = p.photo_url;
      originalLink.classList.remove("disabled");

      const ext = (p.ext || "").toLowerCase();
      if (DISPLAYABLE_EXTENSIONS.has(ext)) {
        // L'image originale s'adapte automatiquement à la taille du
        // navigateur via le CSS (max-width/max-height: 100%).
        img.src = p.photo_url;
        img.alt = p.filename;
        img.classList.remove("hidden");
      } else {
        el("lightbox-unsupported-ext").textContent = `.${ext || "?"}`;
        el("lightbox-unsupported-link").href = p.photo_url;
        unsupported.classList.remove("hidden");
      }

      const dirPath = p.relpath && p.relpath.includes("/")
        ? p.relpath.slice(0, p.relpath.lastIndexOf("/"))
        : ""; // photo à la racine du partage, pas de sous-dossier

      const rows = [
        ["filename", p.filename],
        ["relpath", dirPath],
        ["date_taken", p.date_taken ? p.date_taken.replace("T", " ") : null],
        ["title", p.title],
        ["caption", p.caption],
      ];
      infoList.innerHTML = rows
        .filter(([, val]) => val)
        .map(([key, val]) => `<dt>${FIELD_LABELS[key]}</dt><dd>${escapeHtml(val)}</dd>`)
        .join("");

      if (p.tags && p.tags.length) {
        const pills = p.tags.map((t) => `<span class="tag-pill">${escapeHtml(t)}</span>`).join("");
        infoList.innerHTML += `<dt>Mots-clés</dt><dd><div class="tag-list">${pills}</div></dd>`;
      }
    })
    .catch(() => {
      infoList.innerHTML = "<dt>Erreur</dt><dd>Impossible de charger les informations.</dd>";
    });
}

function closeLightbox() {
  el("lightbox").classList.add("hidden");
  el("lightbox-img").src = "";
  document.body.style.overflow = "";
  // Navigate back to previous history entry, removing modal state
  if (history.state?.modal) {
    history.back();
  } else {
    // If no modal flag, just replace state to keep stack clean
    history.replaceState({}, '');
  }
}

function toggleInfoPanel() {
  el("lightbox-info-panel").classList.toggle("hidden");
}

// --- Navigation photo précédente/suivante ---
// En bout de page (dernière/première photo affichée), bascule
// automatiquement sur la page de résultats suivante/précédente plutôt que
// de s'arrêter.

function updateNavButtons() {
  const globalIndex = (state.page - 1) * state.pageSize + state.currentIndex;
  el("lightbox-prev-btn").disabled = globalIndex <= 0;
  el("lightbox-next-btn").disabled = globalIndex >= state.total - 1;
}

async function showNext() {
  if (state.currentIndex < state.results.length - 1) {
    const newIndex = state.currentIndex + 1;
    openLightbox(state.results[newIndex].id, newIndex);
    return;
  }
  const hasNextPage = state.page * state.pageSize < state.total;
  if (!hasNextPage) return; // déjà la toute dernière photo des résultats
  await runSearch(state.page + 1);
  if (state.results.length > 0) openLightbox(state.results[0].id, 0);
}

async function showPrev() {
  if (state.currentIndex > 0) {
    const newIndex = state.currentIndex - 1;
    openLightbox(state.results[newIndex].id, newIndex);
    return;
  }
  if (state.page <= 1) return; // déjà la toute première photo des résultats
  await runSearch(state.page - 1);
  if (state.results.length > 0) {
    openLightbox(state.results[state.results.length - 1].id, state.results.length - 1);
  }
}

// --- Swipe tactile (Android/iPad/iPhone) : gauche/droite seulement, pas de
// zoom ni de scroll vertical dans la visionneuse pour l'instant. ---
let touchStartX = null;
let touchStartY = null;
const SWIPE_THRESHOLD_PX = 50;

function onLightboxTouchStart(e) {
  if (e.touches.length !== 1) return; // ignore les gestes à 2 doigts (pincement/zoom)
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
}

function onLightboxTouchMove(e) {
  if (touchStartX === null) return;
  e.preventDefault(); // bloque le scroll vertical/rebond tant qu'on est dans la visionneuse
}

function onLightboxTouchEnd(e) {
  if (touchStartX === null) return;
  const touch = e.changedTouches[0];
  const dx = touch.clientX - touchStartX;
  const dy = touch.clientY - touchStartY;
  touchStartX = null;
  touchStartY = null;
  if (Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy)) {
    if (dx < 0) showNext(); else showPrev();
  }
}

el("lightbox-close-btn").addEventListener("click", closeLightbox);
el("lightbox-info-btn").addEventListener("click", toggleInfoPanel);
el("lightbox-prev-btn").addEventListener("click", showPrev);
el("lightbox-next-btn").addEventListener("click", showNext);
el("lightbox").addEventListener("click", (e) => {
  if (e.target.id === "lightbox") closeLightbox(); // clic en dehors de l'image/panneau
});
document.addEventListener("keydown", (e) => {
  if (el("lightbox").classList.contains("hidden")) return;
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowRight") showNext();
  if (e.key === "ArrowLeft") showPrev();
});

const lightboxBody = el("lightbox-body");
lightboxBody.addEventListener("touchstart", onLightboxTouchStart, { passive: true });
lightboxBody.addEventListener("touchmove", onLightboxTouchMove, { passive: false });
lightboxBody.addEventListener("touchend", onLightboxTouchEnd, { passive: true });

el("keyword-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); addKeywordFromInput(); }
  if (e.key === "Escape") { hideSuggestions(); }
});
el("keyword-input").addEventListener("input", (e) => loadTagSuggestions(e.target.value));
el("keyword-input").addEventListener("focus", (e) => loadTagSuggestions(e.target.value));
// "focus" seul ne suffit pas : le champ reste focus après une sélection
// (exprès, voir renderSuggestions), donc un simple clic dessus ensuite ne
// redéclenche pas d'événement focus. "click" comble ce cas.
el("keyword-input").addEventListener("click", (e) => loadTagSuggestions(e.target.value));
document.addEventListener("click", (e) => {
  if (!e.target.closest(".keyword-input-wrap")) hideSuggestions();
});
el("search-btn").addEventListener("click", () => runSearch(1));
el("reset-btn").addEventListener("click", resetFilters);
el("sort-select").addEventListener("change", () => runSearch(1));
el("exclusive-checkbox").addEventListener("change", updateExclusiveState);
el("rescan-btn").addEventListener("click", async () => {
  el("rescan-btn").disabled = true;
  el("rescan-btn").textContent = "Scan en cours…";
  try {
    await fetch("/api/trigger-scan", { method: "POST" });
  } catch (e) { /* ignore */ }
  setTimeout(() => {
    el("rescan-btn").disabled = false;
    el("rescan-btn").textContent = "🔄 Rescanner maintenant";
    loadStatus();
  }, 4000);
});

el("status-btn").addEventListener("click", openStatusModal);
el("status-close-btn").addEventListener("click", closeStatusModal);
el("status-modal").addEventListener("click", (e) => {
  if (e.target.id === "status-modal") closeStatusModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("status-modal").classList.contains("hidden")) closeStatusModal();
});

loadTagSuggestions("", false);
runSearch(1);
