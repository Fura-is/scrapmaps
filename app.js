import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, onSnapshot,
  addDoc, updateDoc, deleteDoc, doc, serverTimestamp, deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------- 0. Check that Firebase keys are filled in ----------
const keysMissing =
  !window.firebaseConfig || String(window.firebaseConfig.apiKey).includes("PASTE");

if (keysMissing) {
  const b = document.getElementById("setupBanner");
  b.classList.remove("hidden");
  b.innerHTML = `<div class="box">
    <h1>Almost there</h1>
    <p>ScrapMap needs your <b>Firebase config</b> before it can run.<br><br>
    Open <code>config.js</code> and paste it in (the map itself needs no key).
    Ask Claude for the step-by-step if you're not sure.<br><br>
    Save the file and reload this page.</p>
  </div>`;
  throw new Error("ScrapMap: Firebase not configured yet (edit config.js).");
}

// ---------- 1. 4-digit code gate ----------
const PIN = String(window.APP_PIN || "");
startGate();

function startGate() {
  if (!PIN || localStorage.getItem("scrapmap_unlocked") === "1") {
    initApp();
    return;
  }
  const gate = document.getElementById("pinGate");
  const input = document.getElementById("pinInput");
  const err = document.getElementById("pinError");
  gate.classList.remove("hidden");
  setTimeout(() => input.focus(), 100);
  input.addEventListener("input", () => {
    err.classList.add("hidden");
    if (input.value.length < 4) return;
    if (input.value === PIN) {
      localStorage.setItem("scrapmap_unlocked", "1");
      gate.classList.add("hidden");
      initApp();
    } else {
      err.classList.remove("hidden");
      input.value = "";
    }
  });
}

// ---------- Everything below runs once unlocked ----------
function initApp() {
  // ----- Firebase -----
  const fbApp = initializeApp(window.firebaseConfig);
  const db = getFirestore(fbApp);
  const placesCol = collection(db, "places");

  // ----- Map (OpenStreetMap via Leaflet) -----
  const [startLng, startLat] = window.MAP_START.center;
  const map = L.map("map", { zoomControl: false }).setView([startLat, startLng], window.MAP_START.zoom);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.control.locate({
    position: "bottomright",
    flyTo: true,
    showPopup: false,
    locateOptions: { enableHighAccuracy: true },
  }).addTo(map);
  setTimeout(() => map.invalidateSize(), 200);

  // Address search (free Nominatim, no key)
  // Unified search: matches your saved companies first, falls back to OpenStreetMap.
  const osmGeocoder = L.Control.Geocoder.nominatim({
    geocodingQueryParams: { addressdetails: 1, "accept-language": "is" },
  });
  function searchLocal(query) {
    const q = (query || "").trim().toLowerCase();
    if (!q) return [];
    return places
      .filter((p) => typeof p.lat === "number" && typeof p.lng === "number")
      .filter((p) => (p.name || "").toLowerCase().includes(q) || (p.address || "").toLowerCase().includes(q))
      .slice(0, 6)
      .map((p) => ({
        name: (p.name || "(no name)") + (p.address ? " — " + shortAddress(p.address) : ""),
        center: L.latLng(p.lat, p.lng),
        bbox: L.latLngBounds([p.lat, p.lng], [p.lat, p.lng]),
        _localId: p.id,
      }));
  }
  const unifiedGeocoder = {
    geocode: function (query, cb, context) {
      const local = searchLocal(query);
      if (local.length) { cb.call(context, local); return; }
      osmGeocoder.geocode(query, cb, context);
    },
    suggest: function (query, cb, context) {
      cb.call(context, searchLocal(query));
    },
    reverse: function (latlng, scale, cb, context) {
      osmGeocoder.reverse(latlng, scale, cb, context);
    },
  };
  L.Control.geocoder({
    defaultMarkGeocode: false,
    collapsed: false,
    placeholder: "Search address or company…",
    position: "topleft",
    suggestMinLength: 1,
    geocoder: unifiedGeocoder,
  })
    .on("markgeocode", (e) => {
      const c = e.geocode.center;
      if (e.geocode._localId) {
        // saved company: zoom in and open its popup
        map.flyTo([c.lat, c.lng], 17);
        const mk = markers.get(e.geocode._localId);
        if (mk) setTimeout(() => mk.openPopup(), 350);
      } else {
        // new address from OpenStreetMap: open the add-place form
        map.flyTo([c.lat, c.lng], 16);
        openSheetForNew({ lng: c.lng, lat: c.lat, name: "", address: formatGeocode(e.geocode) });
      }
    })
    .addTo(map);

  // ----- State -----
  let places = [];
  const markers = new Map();   // id -> L.marker
  let tempMarker = null;
  let editId = null;
  let currentFilter = "all";

  const STATUS_LABEL = {
    spotta: "⚪ 1 · Spotta",
    kobbi: "🟤 2 · Senda á Kobba",
    bidsvar: "🟤 ⏳ Bíð eftir svari (Kobbi)",
    progress: "🟣 3 · Spjalla",
    emailed: "🟡 4 · Senda tölvupóst",
    bidpost: "🟡 ⏳ Búið að senda (bíð eftir svari)",
    customer: "🟢 5 · Nýr kúnni",
    done: "🔴 Búið / ekki áhugi",
    samkeppni: "🟠 Samkeppni (Hring/Málma)",
    fura: "🔵 Fura (okkar)",
    // legacy values kept so old pins still render correctly
    visit: "⚪ 1 · Spotta",
    hringras: "🟠 Samkeppni (Hring/Málma)",
    malmar: "🟠 Samkeppni (Hring/Málma)",
  };
  const MARKER_LETTER = { fura: "F" };

  // OSM labels the capital area by formal municipality ("Hafnarfjarðarkaupstaður");
  // map the postcode to the everyday town name people actually use.
  const POSTCODE_TOWN = {
    "101": "Reykjavík", "102": "Reykjavík", "103": "Reykjavík", "104": "Reykjavík",
    "105": "Reykjavík", "107": "Reykjavík", "108": "Reykjavík", "109": "Reykjavík",
    "110": "Reykjavík", "111": "Reykjavík", "112": "Reykjavík", "113": "Reykjavík",
    "116": "Reykjavík", "121": "Reykjavík", "123": "Reykjavík", "124": "Reykjavík",
    "125": "Reykjavík", "127": "Reykjavík", "128": "Reykjavík", "129": "Reykjavík",
    "130": "Reykjavík", "132": "Reykjavík", "150": "Reykjavík", "155": "Reykjavík",
    "161": "Reykjavík",
    "170": "Seltjarnarnes", "172": "Seltjarnarnes",
    "200": "Kópavogur", "201": "Kópavogur", "202": "Kópavogur", "203": "Kópavogur",
    "206": "Kópavogur",
    "210": "Garðabær", "212": "Garðabær", "225": "Garðabær",
    "220": "Hafnarfjörður", "221": "Hafnarfjörður", "222": "Hafnarfjörður",
    "270": "Mosfellsbær", "271": "Mosfellsbær", "276": "Mosfellsbær",
    "230": "Reykjanesbær", "232": "Reykjanesbær", "233": "Reykjanesbær",
    "235": "Reykjanesbær", "260": "Reykjanesbær",
    "240": "Grindavík", "245": "Suðurnesjabær", "250": "Suðurnesjabær",
  };
  function townFor(post, fallback) {
    return (post && POSTCODE_TOWN[post]) || fallback || "";
  }

  // Build "Rauðhella 9, 221 Hafnarfjörður" from OSM's structured address fields.
  function formatGeocode(geocode) {
    const a = geocode.properties && geocode.properties.address;
    if (a) {
      const road = a.road || a.pedestrian || a.footway || a.path || a.residential || "";
      const num = a.house_number || "";
      const street = [road, num].filter(Boolean).join(" ");
      const post = a.postcode || "";
      const town = townFor(post, a.town || a.city || a.village || a.municipality || a.suburb || a.county || "");
      if (street) {
        const tail = [post, town].filter(Boolean).join(" ");
        return [street, tail].filter(Boolean).join(", ");
      }
    }
    return shortAddress(geocode.name || "");
  }

  // Trim an already-stored OSM string down to "Street 9, 221 Town" (idempotent on short ones).
  function shortAddress(full) {
    if (!full) return "";
    let parts = full.split(",").map((s) => s.trim()).filter(Boolean);
    parts = parts.filter((p) => !/^(ísland|iceland)$/i.test(p));
    if (parts.length <= 2) return parts.join(", ");
    const post = parts.find((p) => /^\d{3}$/.test(p)) || "";
    const named = parts.filter((p) => !/^\d{3}$/.test(p));
    let street;
    if (named.length && /^\d+[a-zA-Z]?$/.test(named[0])) {
      street = (named[1] ? named[1] + " " : "") + named[0];
    } else {
      street = named[0] || "";
    }
    const town = townFor(post, named.length >= 2 ? named[named.length - 2] : "");
    const tail = [post, town].filter(Boolean).join(" ");
    return [street, tail].filter(Boolean).join(", ");
  }

  // ----- DOM refs -----
  const sheet = document.getElementById("sheet");
  const sheetTitle = document.getElementById("sheetTitle");
  const fName = document.getElementById("f_name");
  const fAddress = document.getElementById("f_address");
  const fStatus = document.getElementById("f_status");
  const fNotes = document.getElementById("f_notes");
  const deleteBtn = document.getElementById("deleteBtn");
  const listPanel = document.getElementById("listPanel");
  const listItems = document.getElementById("listItems");
  const listSearch = document.getElementById("listSearch");
  const statusbar = document.getElementById("statusbar");

  // ----- Live data from Firestore -----
  onSnapshot(
    placesCol,
    (snap) => {
      places = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderMarkers();
      renderList();
      statusbar.textContent = `${places.length} place${places.length === 1 ? "" : "s"} · synced`;
    },
    (err) => {
      console.error("Firestore error:", err);
      statusbar.textContent = "⚠ sync error — check Firestore rules";
    }
  );

  // ----- Markers -----
  function makeIcon(status) {
    const size = status === "fura" ? 40 : 24;
    return L.divIcon({
      className: "",
      html: `<div class="marker ${status || "spotta"}">${MARKER_LETTER[status] || ""}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -(size / 2 + 2)],
    });
  }

  function renderMarkers() {
    for (const [id, mk] of markers) {
      const place = places.find((p) => p.id === id);
      if (!place || !passesFilter(place)) {
        map.removeLayer(mk);
        markers.delete(id);
      }
    }
    for (const p of places) {
      if (!passesFilter(p) || typeof p.lng !== "number" || typeof p.lat !== "number") continue;
      if (markers.has(p.id)) {
        const mk = markers.get(p.id);
        mk.setLatLng([p.lat, p.lng]);
        mk.setIcon(makeIcon(p.status));
        mk.setPopupContent(buildPopupEl(p));
        continue;
      }
      const mk = L.marker([p.lat, p.lng], { icon: makeIcon(p.status), draggable: true }).addTo(map);
      mk.bindPopup(buildPopupEl(p));
      mk.on("dragend", async () => {
        const ll = mk.getLatLng();
        try {
          await updateDoc(doc(db, "places", p.id), { lat: ll.lat, lng: ll.lng, updatedAt: serverTimestamp() });
        } catch (e) {
          alert("Could not move pin: " + e.message);
        }
      });
      markers.set(p.id, mk);
    }
  }

  function passesFilter(p) {
    if (currentFilter === "all") return true;
    if (currentFilter === "samkeppni") return p.status === "samkeppni" || p.status === "hringras" || p.status === "malmar";
    if (currentFilter === "spotta") return p.status === "spotta" || p.status === "visit";
    return p.status === currentFilter;
  }

  function buildPopupEl(p) {
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div class="popup-name"></div>
      <div class="popup-status"></div>
      <div class="popup-notes"></div>
      <div class="popup-actions">
        <button class="popup-edit">Edit</button>
        <button class="popup-checklist">+ Checklist</button>
        <button class="popup-maps">🗺 Google Maps</button>
      </div>`;
    wrap.querySelector(".popup-name").textContent = p.name || "(no name)";
    const popupAddr = shortAddress(p.address);
    wrap.querySelector(".popup-status").textContent =
      (STATUS_LABEL[p.status] || "") + (popupAddr ? " · " + popupAddr : "");
    wrap.querySelector(".popup-notes").textContent = p.notes || "";
    wrap.querySelector(".popup-edit").addEventListener("click", () => {
      markers.get(p.id)?.closePopup();
      openSheetForEdit(p);
    });
    wrap.querySelector(".popup-checklist").addEventListener("click", () => {
      markers.get(p.id)?.closePopup();
      openChecklistFor(p);
    });
    wrap.querySelector(".popup-maps").addEventListener("click", () => {
      // Prefer name + saved address so Google finds the actual business;
      // fall back to the pin's exact coordinates if there's no text to search.
      const addr = shortAddress(p.address);
      const text = [p.name, addr].filter(Boolean).join(", ").trim();
      const query = text
        ? encodeURIComponent(text)
        : (typeof p.lat === "number" && typeof p.lng === "number" ? `${p.lat},${p.lng}` : "");
      if (!query) { alert("This pin has no address, name, or location yet."); return; }
      window.open(`https://www.google.com/maps/search/?api=1&query=${query}`, "_blank");
    });
    return wrap;
  }

  // Pre-fill the checklist from a map pin, then switch to the Checklist tab.
  function openChecklistFor(place) {
    const f = checklistForm;
    f.reset();
    clPlaceId = place.id || null;
    clVisitId = null;
    if (checklistTitle) checklistTitle.textContent = "Nýtt fyrirtæki";
    if (place.name) f.company.value = place.name;
    if (place.address) f.address.value = shortAddress(place.address);
    if (place.notes) f.notes.value = place.notes;
    if (typeof place.lat === "number" && typeof place.lng === "number") {
      setClLocation(place.lat, place.lng, shortAddress(place.address) || "núverandi nál");
    } else {
      clearClLocation();
    }
    const legacyMap = { visit: "spotta", hringras: "samkeppni", malmar: "samkeppni" };
    clStatusSel.value = legacyMap[place.status] || place.status || "spotta";
    suggestionsBox.classList.add("hidden");
    showView("checklist");
    setTimeout(() => f.contact.focus(), 100);
  }

  // ----- Bottom sheet -----
  function showTempMarker(lng, lat) {
    if (tempMarker) map.removeLayer(tempMarker);
    tempMarker = L.marker([lat, lng], {
      icon: L.divIcon({ className: "", html: '<div class="marker temp"></div>', iconSize: [24, 24], iconAnchor: [12, 12] }),
    }).addTo(map);
  }
  function clearTempMarker() {
    if (tempMarker) { map.removeLayer(tempMarker); tempMarker = null; }
  }

  function openSheetForNew({ lng, lat, name = "", address = "" }) {
    editId = null;
    sheetTitle.textContent = "New place";
    fName.value = name;
    fAddress.value = address;
    fStatus.value = "spotta";
    fNotes.value = "";
    deleteBtn.classList.add("hidden");
    sheet.dataset.lng = lng;
    sheet.dataset.lat = lat;
    showTempMarker(lng, lat);
    sheet.classList.remove("hidden");
    fName.focus();
  }

  function openSheetForEdit(p) {
    editId = p.id;
    sheetTitle.textContent = "Edit place";
    fName.value = p.name || "";
    fAddress.value = shortAddress(p.address || "");
    const legacyStatus = { visit: "spotta", hringras: "samkeppni", malmar: "samkeppni" };
    fStatus.value = legacyStatus[p.status] || p.status || "spotta";
    fNotes.value = p.notes || "";
    deleteBtn.classList.remove("hidden");
    sheet.dataset.lng = p.lng;
    sheet.dataset.lat = p.lat;
    sheet.classList.remove("hidden");
  }

  function closeSheet() {
    sheet.classList.add("hidden");
    clearTempMarker();
    editId = null;
  }

  document.getElementById("cancelBtn").addEventListener("click", closeSheet);

  document.getElementById("saveBtn").addEventListener("click", async () => {
    const data = {
      name: fName.value.trim() || fAddress.value.trim() || "Untitled",
      address: fAddress.value.trim(),
      status: fStatus.value,
      notes: fNotes.value.trim(),
      lng: Number(sheet.dataset.lng),
      lat: Number(sheet.dataset.lat),
      updatedAt: serverTimestamp(),
    };
    try {
      if (editId) {
        await updateDoc(doc(db, "places", editId), data);
      } else {
        await addDoc(placesCol, { ...data, createdAt: serverTimestamp() });
      }
      closeSheet();
    } catch (e) {
      alert("Could not save: " + e.message);
    }
  });

  deleteBtn.addEventListener("click", async () => {
    if (!editId) return;
    if (!confirm("Delete this place?")) return;
    try {
      await deleteDoc(doc(db, "places", editId));
      closeSheet();
    } catch (e) {
      alert("Could not delete: " + e.message);
    }
  });

  // ----- Add by tapping the map -----
  map.on("click", (e) => {
    if (!sheet.classList.contains("hidden")) return;
    openSheetForNew({ lng: e.latlng.lng, lat: e.latlng.lat });
  });

  // ----- Show all pins -----
  function fitAllPins() {
    document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    document.querySelector('.chip[data-filter="all"]').classList.add("active");
    currentFilter = "all";
    renderMarkers();
    const pts = places
      .filter((p) => typeof p.lat === "number" && typeof p.lng === "number")
      .map((p) => [p.lat, p.lng]);
    if (!pts.length) return;
    if (pts.length === 1) { map.setView(pts[0], 15); return; }
    map.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 16 });
  }
  document.getElementById("fitBtn").addEventListener("click", fitAllPins);

  // ----- List panel -----
  document.getElementById("listBtn").addEventListener("click", () => {
    listPanel.classList.remove("hidden");
    renderList();
  });
  document.getElementById("listClose").addEventListener("click", () =>
    listPanel.classList.add("hidden")
  );
  listSearch.addEventListener("input", renderList);

  function renderList() {
    const q = listSearch.value.trim().toLowerCase();
    const rows = places
      .filter(passesFilter)
      .filter((p) => !q || (p.name || "").toLowerCase().includes(q) || (p.address || "").toLowerCase().includes(q))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    listItems.innerHTML = "";
    if (!rows.length) {
      listItems.innerHTML = `<p style="color:var(--muted);padding:12px">No places yet. Search an address or tap the map to add one.</p>`;
      return;
    }
    for (const p of rows) {
      const row = document.createElement("div");
      row.className = "list-row";
      row.innerHTML = `
        <span class="dot ${p.status || "spotta"}"></span>
        <div class="meta">
          <div class="name"></div>
          <div class="sub"></div>
        </div>`;
      row.querySelector(".name").textContent = p.name || "(no name)";
      const rowAddr = shortAddress(p.address);
      row.querySelector(".sub").textContent =
        (STATUS_LABEL[p.status] || "") + (rowAddr ? " · " + rowAddr : "");
      row.addEventListener("click", () => {
        listPanel.classList.add("hidden");
        map.flyTo([p.lat, p.lng], 16);
        markers.get(p.id)?.openPopup();
      });
      listItems.appendChild(row);
    }
  }

  // ----- Legend filter chips -----
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      currentFilter = chip.dataset.filter;
      renderMarkers();
      renderList();
    });
  });
  document.querySelector('.chip[data-filter="all"]').classList.add("active");

  // ============================================================
  // Tab switching (Map / Checklist / Companies)
  // ============================================================
  function showView(name) {
    document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
    const target = document.getElementById(name + "View");
    if (target) target.classList.remove("hidden");
    // the checklist form is reached via the (+) in Companies, so keep that tab lit
    const activeTab = name === "checklist" ? "companies" : name;
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.view === activeTab);
    });
    if (name === "map") setTimeout(() => map.invalidateSize(), 50);
  }
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showView(tab.dataset.view));
  });

  function todayISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // ============================================================
  // PARTS 2 & 3 — Visits collection (checklist data)
  // ============================================================
  const visitsCol = collection(db, "visits");
  let visits = [];
  let companiesSort = "newest";

  // Fura HQ for "nearest" sort. Falls back to hardcoded Hringhella 3 coords
  // if the Fura map pin is missing.
  function getFuraCoords() {
    const fura = places.find(
      (p) => p.status === "fura" && typeof p.lat === "number" && typeof p.lng === "number"
    );
    if (fura) return { lat: fura.lat, lng: fura.lng };
    return { lat: 64.0443643, lng: -21.9972741 };
  }

  function distanceKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // Match a visit's company to a map pin (handles "ehf." and case differences).
  function findPlaceByCompany(companyName) {
    if (!companyName) return null;
    const norm = (s) => (s || "").toLowerCase().trim().replace(/\s*ehf\.?$/i, "").trim();
    const needle = norm(companyName);
    if (!needle) return null;
    let fuzzy = null;
    for (const p of places) {
      const pname = norm(p.name);
      if (!pname) continue;
      if (pname === needle) return p;
      if (!fuzzy && (pname.includes(needle) || needle.includes(pname))) fuzzy = p;
    }
    return fuzzy;
  }

  function findPlaceCoords(companyName) {
    const p = findPlaceByCompany(companyName);
    if (p && typeof p.lat === "number" && typeof p.lng === "number") {
      return { lat: p.lat, lng: p.lng };
    }
    return null;
  }

  function sortVisits(rows) {
    const sorted = [...rows];
    if (companiesSort === "alpha") {
      return sorted.sort((a, b) =>
        (a.company || "").localeCompare(b.company || "", "is")
      );
    }
    if (companiesSort === "distance") {
      const fura = getFuraCoords();
      return sorted
        .map((v) => {
          const c = findPlaceCoords(v.company);
          const dist = c ? distanceKm(fura.lat, fura.lng, c.lat, c.lng) : Infinity;
          return { v, dist };
        })
        .sort((a, b) => a.dist - b.dist)
        .map((x) => x.v);
    }
    // "newest": createdAt DESC, fallback visitDate DESC, then company A–Ö
    return sorted.sort((a, b) => {
      const aT = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
      const bT = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
      if (aT !== bT) return bT - aT;
      const dCmp = (b.visitDate || "").localeCompare(a.visitDate || "");
      if (dCmp !== 0) return dCmp;
      return (a.company || "").localeCompare(b.company || "", "is");
    });
  }

  onSnapshot(
    visitsCol,
    (snap) => {
      visits = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderCompanies();
    },
    (err) => {
      console.error("Visits sync error:", err);
    }
  );

  // ----- Checklist form -----
  const checklistForm = document.getElementById("checklistForm");
  const checklistMsg = document.getElementById("checklistMsg");

  // Autocomplete: suggest map pins while typing the Fyrirtæki field
  const companyInput = checklistForm.querySelector('input[name="company"]');
  const addressInput = checklistForm.querySelector('input[name="address"]');
  const suggestionsBox = document.getElementById("companySuggestions");

  function renderCompanySuggestions(query) {
    const q = (query || "").trim();
    if (!q) {
      suggestionsBox.classList.add("hidden");
      suggestionsBox.innerHTML = "";
      return;
    }
    const norm = (s) => (s || "").toLowerCase().replace(/\s*ehf\.?$/i, "").trim();
    const needle = norm(q);
    const matches = places
      .filter((p) => {
        const pname = norm(p.name);
        return pname && (pname.includes(needle) || needle.includes(pname));
      })
      .slice(0, 6);
    if (!matches.length) {
      suggestionsBox.classList.add("hidden");
      suggestionsBox.innerHTML = "";
      return;
    }
    suggestionsBox.innerHTML = "";
    for (const p of matches) {
      const item = document.createElement("div");
      item.className = "suggestion-item";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = p.name || "(no name)";
      item.appendChild(name);
      const shortAddr = p.address ? shortAddress(p.address) : "";
      if (shortAddr) {
        const sub = document.createElement("div");
        sub.className = "sub";
        sub.textContent = shortAddr;
        item.appendChild(sub);
      }
      // mousedown fires before the input's blur, so the fill happens before the dropdown hides
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        companyInput.value = p.name || "";
        if (shortAddr) addressInput.value = shortAddr;
        suggestionsBox.classList.add("hidden");
      });
      suggestionsBox.appendChild(item);
    }
    suggestionsBox.classList.remove("hidden");
  }

  companyInput.addEventListener("input", (e) => renderCompanySuggestions(e.target.value));
  companyInput.addEventListener("focus", (e) => renderCompanySuggestions(e.target.value));
  companyInput.addEventListener("blur", () => {
    setTimeout(() => suggestionsBox.classList.add("hidden"), 180);
  });

  // ----- Location capture for the new-company form -----
  const clStatusSel = document.getElementById("cl_status");
  const clLocStatus = document.getElementById("clLocStatus");
  let clLat = null, clLng = null;
  let clPlaceId = null; // set when the form was opened from an existing pin
  let clVisitId = null; // set when editing an existing company (visit)
  const checklistTitle = document.getElementById("checklistTitle");

  function setChecklistMaterials(list) {
    const chosen = new Set(list || []);
    checklistForm.querySelectorAll('input[name="materials"]').forEach((c) => {
      c.checked = chosen.has(c.value);
    });
  }

  function setClLocation(lat, lng, label) {
    clLat = lat; clLng = lng;
    clLocStatus.textContent = "📍 Staðsetning sett" + (label ? " · " + label : "");
    clLocStatus.className = "loc-status ok";
  }
  function clearClLocation() {
    clLat = clLng = null;
    clLocStatus.textContent = "⚠ Engin staðsetning enn — skrifaðu heimilisfang eða notaðu GPS.";
    clLocStatus.className = "loc-status";
  }

  document.getElementById("clFindAddr").addEventListener("click", () => {
    const q = addressInput.value.trim() || companyInput.value.trim();
    if (!q) { clLocStatus.textContent = "Skrifaðu heimilisfang fyrst."; clLocStatus.className = "loc-status err"; return; }
    clLocStatus.textContent = "Leita…"; clLocStatus.className = "loc-status";
    osmGeocoder.geocode(q, (results) => {
      if (results && results.length) {
        const r = results[0];
        setClLocation(r.center.lat, r.center.lng, formatGeocode(r));
        if (!addressInput.value.trim()) addressInput.value = shortAddress(formatGeocode(r));
      } else {
        clLocStatus.textContent = "Fann ekki heimilisfang — prófaðu GPS eða nákvæmara heimilisfang.";
        clLocStatus.className = "loc-status err";
      }
    });
  });

  document.getElementById("clUseGps").addEventListener("click", () => {
    if (!navigator.geolocation) { clLocStatus.textContent = "GPS ekki í boði á þessu tæki."; clLocStatus.className = "loc-status err"; return; }
    clLocStatus.textContent = "Sæki GPS…"; clLocStatus.className = "loc-status";
    navigator.geolocation.getCurrentPosition(
      (pos) => setClLocation(pos.coords.latitude, pos.coords.longitude, "GPS"),
      (err) => { clLocStatus.textContent = "Náði ekki GPS: " + err.message; clLocStatus.className = "loc-status err"; },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // Open the new-company form from the (+) in Companies
  function openNewCompanyForm() {
    checklistForm.reset();
    clearClLocation();
    clPlaceId = null;
    clVisitId = null;
    clStatusSel.value = "spotta";
    if (checklistTitle) checklistTitle.textContent = "Nýtt fyrirtæki";
    checklistMsg.classList.add("hidden");
    showView("checklist");
    setTimeout(() => companyInput.focus(), 50);
  }
  document.getElementById("addCompanyBtn").addEventListener("click", openNewCompanyForm);

  // Reopen an existing company to edit its info + change its stage
  function openCompanyForEdit(v) {
    const f = checklistForm;
    f.reset();
    clVisitId = v.id || null;
    const place = findPlaceByCompany(v.company);
    clPlaceId = place ? place.id : null;
    f.company.value = v.company || "";
    f.address.value = shortAddress(v.address || (place && place.address) || "");
    f.contact.value = v.contact || "";
    f.email.value = v.email || "";
    f.notes.value = v.notes || (place && place.notes) || "";
    setChecklistMaterials(v.materials);
    f.hasForklift.checked = !!v.hasForklift;
    const legacyMap = { visit: "spotta", hringras: "samkeppni", malmar: "samkeppni" };
    if (place && typeof place.lat === "number" && typeof place.lng === "number") {
      setClLocation(place.lat, place.lng, shortAddress(place.address) || "núverandi nál");
      clStatusSel.value = legacyMap[place.status] || place.status || "spotta";
    } else {
      clearClLocation();
      clStatusSel.value = "spotta";
    }
    if (checklistTitle) checklistTitle.textContent = "Breyta fyrirtæki";
    suggestionsBox.classList.add("hidden");
    checklistMsg.classList.add("hidden");
    showView("checklist");
  }
  document.getElementById("checklistBack").addEventListener("click", () => showView("companies"));

  checklistForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    if (clLat == null || clLng == null) {
      checklistMsg.textContent = "Þú verður að setja staðsetningu (heimilisfang eða GPS) áður en þú vistar.";
      checklistMsg.className = "error";
      checklistMsg.classList.remove("hidden");
      return;
    }
    const materials = [...f.querySelectorAll('input[name="materials"]:checked')].map((c) => c.value);
    const company = f.company.value.trim();
    const address = f.address.value.trim();
    const notes = f.notes.value.trim();
    const status = clStatusSel.value || "spotta";
    const wasEdit = !!clVisitId;
    const visitData = {
      company,
      contact: f.contact.value.trim(),
      email: f.email.value.trim(),
      address,
      materials,
      hasForklift: f.hasForklift.checked,
      notes,
      updatedAt: serverTimestamp(),
    };
    try {
      if (clPlaceId) {
        // update the linked map pin (no duplicate)
        await updateDoc(doc(db, "places", clPlaceId), {
          name: company || address || "Untitled",
          address, status, notes,
          lat: clLat, lng: clLng,
          updatedAt: serverTimestamp(),
        });
      } else {
        // brand-new: create the map pin
        await addDoc(placesCol, {
          name: company || address || "Untitled",
          address, status, notes,
          lat: clLat, lng: clLng,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      if (clVisitId) {
        await updateDoc(doc(db, "visits", clVisitId), visitData);
      } else {
        await addDoc(visitsCol, { ...visitData, visitDate: todayISO(), createdAt: serverTimestamp() });
      }
      checklistMsg.textContent = wasEdit ? "✓ Uppfært." : "✓ Vistað — komið á kortið og í Companies.";
      checklistMsg.className = "success";
      checklistMsg.classList.remove("hidden");
      f.reset();
      clearClLocation();
      clPlaceId = null;
      clVisitId = null;
      clStatusSel.value = "spotta";
      if (checklistTitle) checklistTitle.textContent = "Nýtt fyrirtæki";
      setTimeout(() => { checklistMsg.classList.add("hidden"); showView("companies"); }, 1200);
    } catch (err) {
      checklistMsg.textContent = "Tókst ekki að vista: " + err.message;
      checklistMsg.className = "error";
      checklistMsg.classList.remove("hidden");
    }
  });

  document.getElementById("checklistReset").addEventListener("click", () => {
    checklistForm.reset();
    clearClLocation();
    clPlaceId = null;
    clVisitId = null;
    clStatusSel.value = "spotta";
    if (checklistTitle) checklistTitle.textContent = "Nýtt fyrirtæki";
    checklistMsg.classList.add("hidden");
  });

  // ----- Companies (Part 3) -----
  const companiesList = document.getElementById("companiesList");
  const companiesEmpty = document.getElementById("companiesEmpty");
  const companiesSearch = document.getElementById("companiesSearch");
  companiesSearch.addEventListener("input", renderCompanies);
  document.querySelectorAll(".sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".sort-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      companiesSort = btn.dataset.sort;
      renderCompanies();
    });
  });

  function renderCompanies() {
    const q = companiesSearch.value.trim().toLowerCase();
    const filtered = visits.filter((v) => {
      if (!q) return true;
      const hay = [v.company, v.contact, v.email, v.address, v.priorities, v.notes, (v.materials || []).join(" ")]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
    const rows = sortVisits(filtered);

    companiesList.innerHTML = "";
    if (!rows.length) {
      companiesEmpty.classList.remove("hidden");
      return;
    }
    companiesEmpty.classList.add("hidden");
    for (const v of rows) {
      companiesList.appendChild(buildCompanyCard(v));
    }
  }

  function buildCompanyCard(v) {
    const card = document.createElement("div");
    card.className = "company-card";

    const h3 = document.createElement("h3");
    h3.textContent = v.company || "(no name)";
    card.appendChild(h3);

    const meta = document.createElement("div");
    meta.className = "meta";
    const metaBits = [];
    if (v.contact) metaBits.push(v.contact);
    if (v.email) metaBits.push(v.email);
    meta.textContent = metaBits.join(" · ");
    if (metaBits.length) card.appendChild(meta);

    const row = document.createElement("div");
    row.className = "row-line";
    if (v.address) {
      const s = document.createElement("span");
      s.innerHTML = "📍 ";
      const b = document.createElement("b");
      b.textContent = shortAddress(v.address);
      s.appendChild(b);
      row.appendChild(s);
    }
    if (v.visitDate) {
      const s = document.createElement("span");
      s.textContent = "📅 " + formatDate(v.visitDate);
      row.appendChild(s);
    }
    if (v.hasForklift) {
      const s = document.createElement("span");
      s.className = "forklift-mini";
      s.title = "Lyftari á staðnum";
      s.textContent = "🚜";
      row.appendChild(s);
    }
    if (row.childNodes.length) card.appendChild(row);

    if ((v.materials || []).length) {
      const mats = document.createElement("div");
      mats.className = "materials";
      for (const m of v.materials) {
        const chip = document.createElement("span");
        chip.className = "mat-chip";
        chip.textContent = m;
        mats.appendChild(chip);
      }
      card.appendChild(mats);
    }

    if (v.priorities) {
      const p = document.createElement("div");
      p.className = "priorities";
      p.textContent = v.priorities;
      card.appendChild(p);
    }

    if (v.notes) {
      const n = document.createElement("div");
      n.className = "notes";
      n.textContent = v.notes;
      card.appendChild(n);
    }

    const actions = document.createElement("div");
    actions.className = "actions";

    const editBtn = document.createElement("button");
    editBtn.className = "btn primary";
    editBtn.textContent = "✏️ Breyta / staða";
    editBtn.addEventListener("click", () => openCompanyForEdit(v));
    actions.appendChild(editBtn);

    const composeBtn = document.createElement("button");
    composeBtn.className = "btn ghost";
    composeBtn.textContent = "Compose email";
    composeBtn.addEventListener("click", () => composeEmail(v));
    actions.appendChild(composeBtn);

    if (!v.emailSentAt) {
      const markBtn = document.createElement("button");
      markBtn.className = "btn primary";
      markBtn.textContent = "Mark as sent";
      markBtn.addEventListener("click", () => markAsSent(v));
      actions.appendChild(markBtn);
    } else {
      const tag = document.createElement("span");
      tag.className = "sent-tag";
      tag.textContent = "✉ Sent " + formatDate(v.emailSentAt);
      actions.appendChild(tag);

      const unmarkBtn = document.createElement("button");
      unmarkBtn.className = "btn ghost";
      unmarkBtn.textContent = "Undo sent";
      unmarkBtn.addEventListener("click", () => unmarkSent(v));
      actions.appendChild(unmarkBtn);
    }

    const delBtn = document.createElement("button");
    delBtn.className = "btn ghost";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      if (!confirm("Delete this visit?")) return;
      try {
        await deleteDoc(doc(db, "visits", v.id));
      } catch (e) {
        alert("Could not delete: " + e.message);
      }
    });
    actions.appendChild(delBtn);
    card.appendChild(actions);

    return card;
  }

  function formatDate(d) {
    if (!d) return "";
    if (typeof d === "string") {
      const parts = d.split("-");
      if (parts.length === 3) return `${Number(parts[2])}.${Number(parts[1])}.${parts[0]}`;
      return d;
    }
    if (d && typeof d.toDate === "function") d = d.toDate();
    if (d instanceof Date) return d.toLocaleDateString("is-IS");
    return String(d);
  }

  // ----- Email composer (opens Mail.app via mailto:) -----
  // Standard Fura price list. Material key matches the checklist values.
  // `label` is what appears in the email (e.g. checkbox says "Járn", email says "Stál").
  const PRICE_TABLE = {
    "Járn":            { label: "Stál",            price: 12  },
    "Ál":              { label: "Ál",              price: 76  },
    "Ryðfrítt stál":   { label: "Ryðfrítt stál",   price: 80  },
    "Messing":         { label: "Messing",         price: 357 },
    "Kopar":           { label: "Eir / Kopar",     price: 512 },
    "Hreinn koparvír": { label: "Hreinn koparvír", price: 562 },
    "Blý":             { label: "Blý",             price: null },
    "Zink":            { label: "Zink",            price: null },
    "Rafgeymar":       { label: "Rafgeymar",       price: null },
    "Hjólbarðar":      { label: "Hjólbarðar",      price: null },
  };

  async function composeEmail(v) {
    // Build the price list in the order the user checked them
    const priceLines = [];
    for (const m of (v.materials || [])) {
      const info = PRICE_TABLE[m];
      const label = info ? info.label : m;
      const price = info && info.price != null ? `${info.price} kr/kg.` : "[verð] kr/kg.";
      priceLines.push(`${label}: ${price}`);
    }
    // Always include Blandaðir málmar at the end
    priceLines.push("Blandaðir málmar: 12 kr/kg.");

    const greet = v.contact ? `Sæll ${v.contact},` : "Sæll,";
    const lines = [
      greet,
      "",
      "Takk fyrir spjallið um daginn.",
      "",
      "Við getum boðið:",
      ...priceLines,
      "",
      "Við sækjum til ykkar og lánum ílát endurgjaldslaust.",
    ];
    if (v.notes && v.notes.trim()) {
      lines.push(
        "",
        `[Bæta hér við setningu út frá heimsókn: ${v.notes.trim()}]`
      );
    }
    lines.push(
      "",
      "Öll verð eru án VSK.",
      "",
      "Bestu kveðjur,",
      "Elvar Kristinn",
      "Fura"
    );
    const subject = "Verðtilboð fyrir málma";
    const body = lines.join("\n");
    const url = `mailto:${encodeURIComponent(v.email || "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = url;
    // Note: just opens the draft. Use "Mark as sent" to record + flip map pin.
  }

  // ----- Mark / unmark email as sent (this is what flips the map pin) -----
  async function markAsSent(v) {
    try {
      await updateDoc(doc(db, "visits", v.id), { emailSentAt: serverTimestamp() });
    } catch (e) {
      alert("Could not mark sent: " + e.message);
      return;
    }
    try {
      const place = findPlaceByCompany(v.company);
      if (place && ["spotta", "kobbi", "bidsvar", "progress", "emailed", "visit"].includes(place.status)) {
        await updateDoc(doc(db, "places", place.id), {
          status: "bidpost",
          updatedAt: serverTimestamp(),
        });
      }
    } catch (e) {
      console.error("Could not update map pin status:", e);
    }
  }

  async function unmarkSent(v) {
    if (!confirm("Afmerkja sem sendan?")) return;
    try {
      await updateDoc(doc(db, "visits", v.id), { emailSentAt: deleteField() });
    } catch (e) {
      alert("Could not undo: " + e.message);
      return;
    }
    try {
      const place = findPlaceByCompany(v.company);
      if (place && place.status === "emailed") {
        await updateDoc(doc(db, "places", place.id), {
          status: "progress",
          updatedAt: serverTimestamp(),
        });
      }
    } catch (e) {
      console.error("Could not revert map pin status:", e);
    }
  }
}
