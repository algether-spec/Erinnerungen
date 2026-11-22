/* ======================
   SYNC.JS
   Sync-Logik, Code-Verwaltung, Rollen, Update-Mechanismus.
====================== */

/* --- Sync-Zustand ----------------------------------------------- */

let currentSyncCode = "";
let currentDeviceRole = "";
let currentInstallJoinToken = "";
let currentInstallContextKey = "";
let syncEditMode = false;
let lastSyncAt = "";
let hintergrundTimer = null;
let updatePruefTimer = null;
let remoteSyncInFlight = false;
let remoteSyncQueued = false;
let lokaleAenderungen = 0;
let lokalSpeicherFehler = false;
let remotePullInFlight = false;
let localDirty = false;
let _geraeteAnzahlTimer = null;
let _geraeteAnzahlKanal = null;
let _geraeteAnzahl = 0;


/* --- Sync-Code Validierung & Generierung ------------------------ */

function syncCodeNormalisieren(input) {
    const raw = String(input || "").toUpperCase();
    const letters = raw.replace(/[^A-Z]/g, "").slice(0, 4);
    const digits = raw.replace(/\D/g, "").slice(0, 4);
    return (letters + digits).slice(0, SYNC_CODE_LENGTH);
}

function istGueltigerSyncCode(code) {
    return /^[A-Z]{4}[0-9]{4}$/.test(String(code || ""));
}

function istReservierterSyncCode(code) {
    return code === RESERVED_SYNC_CODE;
}

function istGueltigeGeraeteRolle(rolle) {
    return rolle === "hauptgeraet" || rolle === "gast";
}

function syncCodeErzeugen() {
    const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let nextCode = RESERVED_SYNC_CODE;
    while (istReservierterSyncCode(nextCode)) {
        let letters = "";
        for (let i = 0; i < 4; i += 1) {
            letters += LETTERS[Math.floor(Math.random() * LETTERS.length)];
        }
        const digits = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
        nextCode = letters + digits;
    }
    return nextCode;
}


/* --- Sync-Code Speichern ---------------------------------------- */

function syncCodeSpeichern(code) {
    localStorage.setItem(SYNC_CODE_KEY, code);
}

function syncCodePermanentSpeichern(code) {
    localStorage.setItem(SYNC_CODE_PERMANENT_KEY, code);
    syncCodeSpeichern(code);
    void einladungInDbSpeichern(code);
}

async function syncCodeLadenMitBackup() {
    // 1. Permanenter Slot
    const fromPermanent = syncCodeNormalisieren(localStorage.getItem(SYNC_CODE_PERMANENT_KEY) || "");
    if (istGueltigerSyncCode(fromPermanent) && !istReservierterSyncCode(fromPermanent)) {
        localStorage.setItem(SYNC_CODE_KEY, fromPermanent);
        return fromPermanent;
    }

    // 2. Normaler localStorage-Slot
    const fromLs = syncCodeNormalisieren(localStorage.getItem(SYNC_CODE_KEY) || "");
    if (istGueltigerSyncCode(fromLs) && !istReservierterSyncCode(fromLs)) return fromLs;

    // 3. Neuen Code erzeugen
    const created = syncCodeErzeugen();
    syncCodeSpeichern(created);
    return created;
}


/* --- Geräte-Rolle ----------------------------------------------- */

function geraetRolleLesen() {
    return currentDeviceRole || "";
}

function geraetRolleSetzen(rolle) {
    currentDeviceRole = istGueltigeGeraeteRolle(rolle) ? rolle : "";
    geraetRolleUiAktualisieren();
}

async function geraetRolleInSupabaseSpeichern(rolle, syncCode) {
    if (!supabaseClient || !istGueltigeGeraeteRolle(rolle) || !syncCode) return;
    try {
        if (!(await authSicherstellen())) return;
        await supabaseClient.from("device_roles").upsert({
            device_id: geraeteIdLaden(),
            rolle,
            sync_code: syncCode,
            updated_at: new Date().toISOString()
        }, { onConflict: "device_id" });
    } catch (err) {
        console.warn("Geraete-Rolle in Supabase speichern fehlgeschlagen:", err);
    }
}

function geraetRolleUiAktualisieren() {
    const rolle = geraetRolleLesen();
    const hatCode = istGueltigerSyncCode(currentSyncCode) && !istReservierterSyncCode(currentSyncCode);

    // Teilen: nur Hauptgerät mit gültigem Code
    if (typeof btnSyncCodeShare !== "undefined" && btnSyncCodeShare)
        btnSyncCodeShare.hidden = (rolle !== "hauptgeraet" || !hatCode);

    // Verbinden: nur für neue Geräte (Rolle noch leer)
    if (typeof btnSyncConnect !== "undefined" && btnSyncConnect)
        btnSyncConnect.hidden = (rolle !== "");

    // Wechseln: nur für Hauptgerät mit gültigem Code
    if (typeof btnSyncCodeChange !== "undefined" && btnSyncCodeChange)
        btnSyncCodeChange.hidden = (rolle !== "hauptgeraet" || !hatCode);

    // Versions-Badge
    if (typeof versionBadge !== "undefined" && versionBadge) {
        const anzahlLabel = (rolle === "hauptgeraet" && _geraeteAnzahl > 0) ? ` · ${_geraeteAnzahl}` : "";
        const rolleLabel = rolle === "hauptgeraet" ? " · Hauptgerät"
                         : rolle === "gast"        ? " · Gast"
                         : "";
        versionBadge.textContent = "v" + APP_VERSION + rolleLabel + anzahlLabel;
    }

    // Geräte-Anzahl: nur Hauptgerät
    if (rolle === "hauptgeraet" && hatCode) {
        if (!_geraeteAnzahlKanal) geraeteAnzahlSyncStarten();
    } else {
        geraeteAnzahlSyncStoppen();
    }
}


/* --- Geräte-Anzahl ---------------------------------------------- */

async function _geraeteAnzahlAktualisieren() {
    if (geraetRolleLesen() !== "hauptgeraet" || !currentSyncCode) return;
    _geraeteAnzahl = await geraeteAnzahlLaden(currentSyncCode);
    geraetRolleUiAktualisieren();
}

function geraeteAnzahlSyncStarten() {
    geraeteAnzahlSyncStoppen();
    if (!supabaseClient || !currentSyncCode || geraetRolleLesen() !== "hauptgeraet") return;

    void _geraeteAnzahlAktualisieren();
    _geraeteAnzahlTimer = setInterval(() => void _geraeteAnzahlAktualisieren(), 30000);

    _geraeteAnzahlKanal = supabaseClient
        .channel(`device_roles_${currentSyncCode}`)
        .on("postgres_changes", {
            event: "*",
            schema: "public",
            table: "device_roles",
            filter: `sync_code=eq.${currentSyncCode}`
        }, () => void _geraeteAnzahlAktualisieren())
        .subscribe(status => {
            if (status === "CHANNEL_ERROR") {
                console.warn("Geraete-Realtime Fehler, nutze Polling.");
                try { supabaseClient.removeChannel(_geraeteAnzahlKanal); } catch (_) {}
                _geraeteAnzahlKanal = null;
            }
        });
}

function geraeteAnzahlSyncStoppen() {
    if (_geraeteAnzahlTimer) { clearInterval(_geraeteAnzahlTimer); _geraeteAnzahlTimer = null; }
    if (_geraeteAnzahlKanal && supabaseClient) {
        try { supabaseClient.removeChannel(_geraeteAnzahlKanal); } catch (_) {}
        _geraeteAnzahlKanal = null;
    }
    _geraeteAnzahl = 0;
}


/* --- Initialer Geräte-Status ------------------------------------ */

async function initialenGeraeteStatusErmitteln(options = {}) {
    const deviceId = geraeteIdLaden();
    const joinToken = String(options.joinToken || "").trim();
    const legacyInviteDeviceId = String(options.legacyInviteDeviceId || "").trim();

    if (supabaseClient) {
        const bestehend = await geraetStatusAusSupabaseLaden(deviceId);
        if (bestehend?.rolle && bestehend?.syncCode) return bestehend;

        if (joinToken) {
            const viaJoin = await geraetStatusMitJoinTokenRegistrieren(deviceId, joinToken);
            if (viaJoin?.rolle && viaJoin?.syncCode) return viaJoin;
        }

        if (legacyInviteDeviceId) {
            const legacyStatus = await gastStatusAusLegacyEinladungLaden(legacyInviteDeviceId);
            if (legacyStatus?.syncCode) {
                await geraetRolleInSupabaseSpeichern("gast", legacyStatus.syncCode);
                return legacyStatus;
            }
        }
    }

    return null;
}

function zielRolleFuerCodeAnwenden(options = {}) {
    const explicitRole = istGueltigeGeraeteRolle(options.targetRole) ? options.targetRole : "";
    if (explicitRole) return explicitRole;
    if (istGueltigeGeraeteRolle(currentDeviceRole)) return currentDeviceRole;
    if (options.disableAutoRole) return "";
    return options.userInitiated ? "gast" : "hauptgeraet";
}


/* --- Install-Kontext -------------------------------------------- */

function _swInstallKontextSenden(context = {}) {
    if (!("serviceWorker" in navigator)) return;
    const ctrl = navigator.serviceWorker.controller;
    const payload = {
        type: "SET_INSTALL_CONTEXT",
        joinToken: String(context.joinToken || ""),
        inviteDeviceId: String(context.inviteDeviceId || ""),
        code: String(context.code || "")
    };
    if (ctrl) {
        ctrl.postMessage(payload);
        return;
    }
    navigator.serviceWorker.ready.then(reg => {
        if (reg.active) reg.active.postMessage(payload);
    }).catch(() => {});
}

async function installKontextAktualisieren() {
    if (!supabaseClient) return;
    const rolle = geraetRolleLesen();
    if (!istGueltigeGeraeteRolle(rolle) || !istGueltigerSyncCode(currentSyncCode)) return;
    const nextKey = `${rolle}:${currentSyncCode}`;
    if (currentInstallJoinToken && currentInstallContextKey === nextKey) {
        _swInstallKontextSenden({ joinToken: currentInstallJoinToken, code: currentSyncCode });
        return;
    }
    const joinToken = joinTokenErzeugen();
    const saved = await joinTokenInSupabaseSpeichern(joinToken, rolle, currentSyncCode, {
        createdByDeviceId: geraeteIdLaden(),
        expiresInMs: 1000 * 60 * 60 * 24 * 30
    });
    if (saved?.joinToken) {
        currentInstallJoinToken = saved.joinToken;
        currentInstallContextKey = nextKey;
        _swInstallKontextSenden({ joinToken: currentInstallJoinToken, code: currentSyncCode });
    } else {
        const inviteDeviceId = rolle === "gast" ? geraeteIdLaden() : "";
        _swInstallKontextSenden({ inviteDeviceId, code: currentSyncCode });
    }
}


/* --- Daten-Normalisierung --------------------------------------- */

function normalizeListData(daten) {
    if (!Array.isArray(daten)) return [];
    const seenItemIds = new Set();
    return daten
        .map((e, index) => {
            const itemId = String(e?.itemId || e?.item_id || "").trim();
            const text = String(e?.text || e?.title || "").trim();
            const title = String(e?.title || text).trim();
            const note = String(e?.note || "").trim();
            const createdAt =
                normalizeDateIso(e?.createdAt || e?.created_at)
                || extractDateFromItemId(itemId);
            const entryDate =
                normalizeDateIso(e?.entryDate || e?.entry_date || e?.createdAt || e?.created_at)
                || createdAt;
            const dueDate = String(e?.dueDate || e?.due_date || "").trim().slice(0, 10);
            return {
                itemId,
                text: text || title,
                title: title || text,
                note,
                erledigt: Boolean(e?.erledigt),
                createdAt,
                entryDate,
                dueDate,
                position: Number.isFinite(e?.position) ? e.position : index
            };
        })
        .filter(e => (e.text || e.title).length > 0)
        .map(e => {
            let itemId = e.itemId || generateItemId();
            if (seenItemIds.has(itemId)) itemId = generateItemId();
            seenItemIds.add(itemId);
            return { ...e, itemId };
        })
        .map((e, index) => ({ ...e, position: index }));
}

function listDataSignature(daten) {
    return JSON.stringify(
        normalizeListData(daten).map(e => ({
            itemId: e.itemId,
            text: e.text.toLowerCase(),
            title: e.title.toLowerCase(),
            note: e.note.toLowerCase(),
            erledigt: e.erledigt,
            createdAt: e.createdAt || "",
            entryDate: e.entryDate || "",
            dueDate: e.dueDate || "",
            position: e.position
        }))
    );
}

/* --- Drei-Wege-Abgleich ----------------------------------------- */
// Basis = Einträge (ID → Inhalts-Prüfsumme), die beim letzten erfolgreichen Abgleich
// auf dem Server UND in der lokalen Liste waren. Damit lässt sich unterscheiden,
// ob ein fehlender Eintrag gelöscht wurde oder neu ist – und ob ein Eintrag auf
// diesem Gerät geändert wurde oder nur einen alten Stand hat.

function syncBasisLaden() {
    try {
        const raw = JSON.parse(localStorage.getItem(SYNC_BASIS_KEY) || "null");
        if (raw?.code !== currentSyncCode || !Array.isArray(raw.ids)) return null;
        const hashes = raw.hashes || {};
        return new Map(raw.ids.map(id => [id, hashes[id]]));
    } catch (_) {
        return null;
    }
}

// Basis nur speichern, wenn auch die lokale Liste gespeichert ist – sonst könnte
// nach einem Neustart ein Eintrag fälschlich als "lokal gelöscht" gelten.
function syncBasisSetzen(daten) {
    try {
        if (lokalSpeicherFehler) {
            localStorage.removeItem(SYNC_BASIS_KEY);
            return;
        }
        const ids = daten.map(e => e.itemId);
        const hashes = Object.fromEntries(daten.map(e => [e.itemId, inhaltPruefsumme(e)]));
        localStorage.setItem(SYNC_BASIS_KEY, JSON.stringify({ code: currentSyncCode, ids, hashes }));
    } catch (_) {}
}

function lokalMitBasisSpeichern(daten) {
    try {
        localStorage.removeItem(SYNC_BASIS_KEY);
        speichernLokal(daten);
        lokalSpeicherFehler = false;
    } catch (err) {
        console.warn("Lokales Speichern fehlgeschlagen:", err);
        lokalSpeicherFehler = true;
    }
    syncBasisSetzen(daten);
}

// Kurze Prüfsumme statt Inhalt – Fotos sind mehrere MB groß
function inhaltPruefsumme(e) {
    const s = JSON.stringify([e.text, e.title, e.note, e.erledigt, e.dueDate || ""]);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h.toString(36);
}

// Lokale Version nur, wenn der Eintrag hier seit dem letzten Abgleich geändert
// wurde – sonst hat dieses Gerät nur einen alten Stand und der Server gilt
function aktuelleVersion(lokalEintrag, remoteEintrag, basis) {
    if (!remoteEintrag) return lokalEintrag;
    const basisHash = basis.get(lokalEintrag.itemId);
    const lokalGeaendert = basisHash !== undefined && basisHash !== inhaltPruefsumme(lokalEintrag);
    return lokalGeaendert ? lokalEintrag : remoteEintrag;
}

function listenAbgleichen(lokal, remote, basis) {
    const remoteById = new Map(remote.map(e => [e.itemId, e]));
    const lokalIds = new Set(lokal.map(e => e.itemId));
    // lokal vorhanden: behalten, außer er war schon auf dem Server und ist dort gelöscht
    const behalten = lokal
        .filter(e => remoteById.has(e.itemId) || !basis.has(e.itemId))
        .map(e => aktuelleVersion(e, remoteById.get(e.itemId), basis));
    const nurRemote = remote.filter(e => !lokalIds.has(e.itemId));
    const neuRemote = nurRemote.filter(e => !basis.has(e.itemId));
    const loeschen = nurRemote.filter(e => basis.has(e.itemId)).map(e => e.itemId);
    const daten = [...behalten, ...neuRemote].map((e, i) => ({ ...e, position: i }));
    return { daten, loeschen };
}

function eintragSignatur(e) {
    return JSON.stringify([e.text, e.title, e.note, e.erledigt, e.dueDate || "", e.position]);
}

function geaenderteEintraege(daten, remote) {
    const remoteSig = new Map(remote.map(e => [e.itemId, eintragSignatur(e)]));
    return daten.filter(e => remoteSig.get(e.itemId) !== eintragSignatur(e));
}


/* --- Lokales Speichern & Laden ---------------------------------- */

function speichernLokal(daten) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(daten));
}

function ladenLokal() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((e, index) => ({
                itemId: String(e.itemId || e.item_id || "").trim() || generateItemId(),
                text: String(e.text || e.title || ""),
                title: String(e.title || e.text || ""),
                note: String(e.note || ""),
                erledigt: Boolean(e.erledigt),
                createdAt: normalizeDateIso(e.createdAt || e.created_at) || extractDateFromItemId(e.itemId || e.item_id),
                entryDate:
                    normalizeDateIso(e.entryDate || e.entry_date || e.createdAt || e.created_at)
                    || extractDateFromItemId(e.itemId || e.item_id),
                dueDate: String(e.dueDate || e.due_date || "").trim().slice(0, 10),
                position: Number.isFinite(e.position) ? e.position : index
            }))
            .filter(e => (e.text || e.title).trim().length > 0);
    } catch (err) {
        console.warn("Fehler beim lokalen Laden:", err);
        return [];
    }
}


/* --- Sync-Hauptlogik -------------------------------------------- */

function speichern() {
    const daten = datenAusListeLesen();
    localDirty = true; // immer zuerst – auch wenn lokales Speichern scheitert
    lokaleAenderungen += 1;
    try {
        speichernLokal(daten);
        lokalSpeicherFehler = false;
    } catch (err) {
        // QuotaExceededError (häufig nach mehreren Fotos): gespeicherte Liste ist
        // jetzt älter als die Basis → Basis verwerfen, damit nichts falsch gelöscht wird
        console.warn("Lokales Speichern fehlgeschlagen:", err);
        lokalSpeicherFehler = true;
        try { localStorage.removeItem(SYNC_BASIS_KEY); } catch (_) {}
    }
    void syncRemoteIfNeeded();
}

// Ein Abgleich: Server holen, drei Wege vergleichen, gezielt hochladen/löschen
async function einmalAbgleichen() {
    const stand = lokaleAenderungen;
    const lokal = normalizeListData(datenAusListeLesen());
    const remoteRoh = await ladenRemote();
    if (!Array.isArray(remoteRoh)) throw new Error("network offline");
    const remote = normalizeListData(remoteRoh);
    const basis = syncBasisLaden();

    // Ohne Basis (erster Start, Code-Wechsel): Server-Stand gilt, wie bisher
    const { daten, loeschen } = basis
        ? listenAbgleichen(lokal, remote, basis)
        : { daten: remote.length ? remote : lokal, loeschen: [] };

    await eintraegeHochladen(geaenderteEintraege(daten, remote));
    await eintraegeRemoteLoeschen(loeschen);

    // Nutzer hat während des Abgleichs etwas geändert → Liste nicht überschreiben, nochmal.
    // Basis = lokal bekannte Einträge, die jetzt auf dem Server sind (sonst käme ein
    // gerade hochgeladener und gleich wieder gelöschter Eintrag zurück) – mit dem
    // lokalen Inhalt, damit unveränderte Einträge beim nächsten Mal den Server-Stand bekommen.
    if (stand !== lokaleAenderungen) {
        const serverIds = new Set(daten.map(e => e.itemId));
        syncBasisSetzen(lokal.filter(e => serverIds.has(e.itemId)));
        remoteSyncQueued = true;
        return;
    }
    if (listDataSignature(daten) !== listDataSignature(lokal)) {
        datenInListeSchreiben(daten);
        authStatusSetzen("Liste mit anderem Geraet abgeglichen.");
    }
    lokalMitBasisSpeichern(daten);
    localDirty = false;
}

async function syncRemoteIfNeeded() {
    if (!supabaseClient) return;
    if (remoteSyncInFlight) {
        remoteSyncQueued = true;
        return;
    }

    remoteSyncInFlight = true;
    try {
        syncStatusSetzen("Sync: Synchronisiere...", "warn");
        do {
            remoteSyncQueued = false;
            await einmalAbgleichen();
        } while (remoteSyncQueued);
        lastSyncAt = formatTimeIso(new Date());
        syncStatusSetzen("Sync: Verbunden", "ok");
        syncDebugAktualisieren();
    } catch (err) {
        console.warn("Remote-Sync fehlgeschlagen, lokal bleibt aktiv:", err, formatSupabaseError(err));
        syncStatusSetzen("Sync: Offline (lokal)", "offline");
        authStatusSetzen(syncFehlerHinweis(err));
        syncDebugAktualisieren();
    } finally {
        remoteSyncInFlight = false;
    }
}

// Hintergrund: Server-Stand übernehmen. Ungespeicherte lokale Änderungen
// gehen über den Abgleich (der auch Löschungen richtig behandelt).
async function refreshFromRemoteIfChanged() {
    if (!supabaseClient) return;
    if (remoteSyncInFlight || remotePullInFlight) return;
    if (localDirty) {
        void syncRemoteIfNeeded();
        return;
    }

    remotePullInFlight = true;
    const stand = lokaleAenderungen;
    try {
        const remoteDaten = await ladenRemote();
        if (!Array.isArray(remoteDaten)) return;
        // Inzwischen lokal geändert oder Abgleich gestartet → veraltete Antwort verwerfen
        if (stand !== lokaleAenderungen || remoteSyncInFlight || localDirty) return;

        const normalizedRemote = normalizeListData(remoteDaten);
        const lokaleDaten = normalizeListData(datenAusListeLesen());
        if (listDataSignature(normalizedRemote) !== listDataSignature(lokaleDaten)) {
            datenInListeSchreiben(normalizedRemote);
            lokalMitBasisSpeichern(normalizedRemote);
            authStatusSetzen("Liste von anderem Geraet aktualisiert.");
        } else if (!syncBasisLaden()) {
            syncBasisSetzen(normalizedRemote);
        }

        lastSyncAt = formatTimeIso(new Date());
        syncStatusSetzen("Sync: Verbunden", "ok");
        syncDebugAktualisieren();
    } catch (err) {
        console.warn("Remote-Refresh fehlgeschlagen:", err, formatSupabaseError(err));
        syncStatusSetzen("Sync: Offline (lokal)", "offline");
        authStatusSetzen(syncFehlerHinweis(err));
        syncDebugAktualisieren();
    } finally {
        remotePullInFlight = false;
    }
}

async function laden() {
    const lokaleDaten = ladenLokal();
    datenInListeSchreiben(lokaleDaten);

    if (!supabaseClient) {
        syncStatusSetzen("Sync: Lokal", "offline");
        syncDebugAktualisieren();
        return;
    }
    await syncRemoteIfNeeded();
}


/* --- Sync-Code Anwenden ----------------------------------------- */

async function syncCodeAnwenden(code, shouldReload = true, options = {}) {
    const allowOccupied = options.allowOccupied !== false;
    const userInitiated = options.userInitiated === true;
    const normalized = syncCodeNormalisieren(code);
    const zielRolle = zielRolleFuerCodeAnwenden({
        targetRole: options.targetRole,
        userInitiated,
        disableAutoRole: options.disableAutoRole === true
    });

    if (!istGueltigerSyncCode(normalized)) {
        authStatusSetzen("Bitte Code im Format AAAA1234 eingeben.");
        if (userInitiated) syncBearbeitungsmodusSetzen(true);
        return;
    }
    if (istReservierterSyncCode(normalized)) {
        authStatusSetzen("Code HELP0000 ist reserviert und kann nicht verwendet werden.");
        if (syncCodeInput) syncCodeInput.value = currentSyncCode || "";
        if (userInitiated) syncBearbeitungsmodusSetzen(true);
        return;
    }

    // Beim initialen Laden: Code sofort lokal setzen
    if (!userInitiated) {
        currentSyncCode = normalized;
        syncCodeSpeichern(currentSyncCode);
        if (btnSyncCodeDisplay) btnSyncCodeDisplay.textContent = currentSyncCode;
        if (syncCodeInput) syncCodeInput.value = currentSyncCode;
        syncDebugAktualisieren();
    }

    // Ohne Supabase-Client: nur lokal speichern
    if (!supabaseClient) {
        eingabeFehlerSetzen("");
        if (userInitiated) {
            currentSyncCode = normalized;
            syncCodePermanentSpeichern(currentSyncCode);
            if (btnSyncCodeDisplay) btnSyncCodeDisplay.textContent = currentSyncCode;
            authStatusSetzen("Sync nicht verfuegbar. Code lokal gespeichert.");
            syncBearbeitungsmodusSetzen(false);
            syncDebugAktualisieren();
        }
        geraetRolleSetzen(zielRolle);
        return;
    }

    try {
        await syncCodeRpcVerwenden(normalized, {
            allowCreate: true,
            requireNew: !allowOccupied && normalized !== currentSyncCode
        });
    } catch (err) {
        console.warn("Code-Verbinden fehlgeschlagen:", err);
        const hint = syncFehlerHinweis(err);
        const istBelegt = String(formatSupabaseError(err)).includes("SYNC_CODE_ALREADY_EXISTS");

        if (istBelegt) {
            authStatusSetzen("Code ist bereits belegt. Bitte anderen Code nutzen.");
            if (userInitiated && syncCodeInput) {
                syncBearbeitungsmodusSetzen(true);
                syncCodeInput.value = currentSyncCode || normalized || "";
                syncCodeInput.focus();
                syncCodeInput.select();
            }
        } else {
            currentSyncCode = normalized;
            syncCodePermanentSpeichern(currentSyncCode);
            if (btnSyncCodeDisplay) btnSyncCodeDisplay.textContent = currentSyncCode;
            authStatusSetzen(hint);
            if (userInitiated) syncBearbeitungsmodusSetzen(false);
            geraetRolleSetzen(zielRolle);
            syncDebugAktualisieren();
        }
        return;
    }

    currentSyncCode = normalized;
    syncCodePermanentSpeichern(currentSyncCode);
    if (syncCodeInput) syncCodeInput.value = currentSyncCode;
    if (btnSyncCodeDisplay) btnSyncCodeDisplay.textContent = currentSyncCode;
    authStatusSetzen(`Geraete-Code: ${currentSyncCode}`);
    eingabeFehlerSetzen("");
    geraetRolleSetzen(zielRolle);
    await geraetRolleInSupabaseSpeichern(zielRolle, currentSyncCode);
    await installKontextAktualisieren();
    if (userInitiated) syncBearbeitungsmodusSetzen(false);
    if (syncCodeInput) syncCodeInput.blur();
    if (supabaseClient) echtzeitSyncStarten();
    syncDebugAktualisieren();
    if (shouldReload) void laden();
}


/* --- Teilen ----------------------------------------------------- */

async function syncCodeTeilen() {
    if (!currentSyncCode || !istGueltigerSyncCode(currentSyncCode)) {
        authStatusSetzen("Kein gültiger Code zum Teilen vorhanden.");
        return;
    }
    const shareUrl = new URL(location.origin + location.pathname);

    if (supabaseClient) {
        try {
            const joinToken = joinTokenErzeugen();
            const gespeichert = await joinTokenInSupabaseSpeichern(joinToken, "gast", currentSyncCode, {
                createdByDeviceId: geraeteIdLaden(),
                expiresInMs: 1000 * 60 * 60 * 24 * 30
            });
            if (!gespeichert?.joinToken) throw new Error("JOIN_TOKEN_SAVE_FAILED");
            shareUrl.hash = "join=" + gespeichert.joinToken;
        } catch (_) {
            await einladungInDbSpeichern(currentSyncCode);
            shareUrl.hash = "invite=" + geraeteIdLaden();
        }
    } else {
        shareUrl.hash = "code=" + currentSyncCode;
    }

    const url = shareUrl.toString();

    if (navigator.share) {
        try {
            await navigator.share({
                title: "Erinnerungen",
                text: `Tritt meinen Erinnerungen bei! Code: ${currentSyncCode}`,
                url
            });
            return;
        } catch (err) {
            if (err.name === "AbortError") return;
        }
    }

    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        authStatusSetzen("Link kopiert! Zum Einfügen gedrückt halten.");
    } else {
        prompt("Link kopieren:", url);
    }
}


/* --- Sync-Code UI ----------------------------------------------- */

function syncBearbeitungsmodusSetzen(enabled) {
    syncEditMode = Boolean(enabled);
    const darfBearbeiten = geraetRolleLesen() !== "gast";
    const showAuthBar = syncEditMode && modus === MODUS_ERFASSEN && darfBearbeiten;
    if (authBar) authBar.hidden = !showAuthBar;
    if (syncCodeCompact) syncCodeCompact.hidden = modus !== MODUS_ERFASSEN;
    if (syncCodeInput && syncEditMode && modus === MODUS_ERFASSEN) {
        syncCodeInput.focus();
        syncCodeInput.select();
    }
}

function syncCodeUiEinrichten(initOptions = {}) {
    if (!authBar) return Promise.resolve();

    const initPromise = initialenGeraeteStatusErmitteln(initOptions)
        .then(async status => {
            const initialRole = status?.rolle || "";
            const initialCode = status?.syncCode || await syncCodeLadenMitBackup();
            const requiresServerRole = Boolean((initOptions.joinToken || initOptions.legacyInviteDeviceId) && !initialRole);
            if (initialRole) geraetRolleSetzen(initialRole);
            await syncCodeAnwenden(initialCode, false, {
                targetRole: initialRole,
                disableAutoRole: requiresServerRole
            });
        })
        .then(async () => {
            if (supabaseClient && currentSyncCode) void einladungInDbSpeichern(currentSyncCode);
            if (supabaseClient && currentSyncCode) void installKontextAktualisieren();
            geraetRolleUiAktualisieren();
        })
        .catch(err => console.warn("Initialer Sync-Code fehlgeschlagen:", err));

    syncBearbeitungsmodusSetzen(false);

    if (!hasSupabaseCredentials) {
        const msg = "Supabase nicht konfiguriert. App laeuft nur lokal.";
        authStatusSetzen(msg);
        eingabeFehlerSetzen(msg);
    } else if (!hasSupabaseLibrary) {
        const msg = "Supabase nicht geladen. Internet pruefen und neu laden.";
        authStatusSetzen(msg);
        eingabeFehlerSetzen(msg);
    } else {
        eingabeFehlerSetzen("");
    }

    if (syncCodeInput) {
        syncCodeInput.addEventListener("input", () => {
            const normalized = syncCodeNormalisieren(syncCodeInput.value);
            if (syncCodeInput.value !== normalized) {
                const cursorPos = syncCodeInput.selectionStart ?? normalized.length;
                const delta = normalized.length - syncCodeInput.value.length;
                syncCodeInput.value = normalized;
                const newPos = Math.max(0, Math.min(cursorPos + delta, normalized.length));
                syncCodeInput.setSelectionRange(newPos, newPos);
            }
        });
    }

    function syncButtonsDeaktivieren(disabled) {
        if (btnSyncApply) btnSyncApply.disabled = disabled;
    }

    if (btnSyncApply) {
        btnSyncApply.onclick = async () => {
            syncButtonsDeaktivieren(true);
            authStatusSetzen("Verbinde...");
            try {
                await syncCodeAnwenden(syncCodeInput?.value || "", true, { allowOccupied: true, userInitiated: true });
            } finally {
                syncButtonsDeaktivieren(false);
            }
        };
    }

    if (btnSyncConnect) {
        btnSyncConnect.onclick = () => {
            if (syncCodeInput) syncCodeInput.value = "";
            syncBearbeitungsmodusSetzen(true);
        };
    }

    if (btnSyncCodeChange) {
        btnSyncCodeChange.onclick = () => {
            if (syncCodeInput) syncCodeInput.value = "";
            syncBearbeitungsmodusSetzen(true);
        };
    }

    if (btnSyncCodeShare) {
        btnSyncCodeShare.onclick = () => void syncCodeTeilen();
    }

    if (typeof btnSyncCancel !== "undefined" && btnSyncCancel) {
        btnSyncCancel.onclick = () => syncBearbeitungsmodusSetzen(false);
    }

    geraetRolleUiAktualisieren();

    return initPromise;
}


/* --- Hintergrund-Sync ------------------------------------------- */

async function autoWiederverbinden() {
    if (!supabaseClient) return;
    if (keinNetzwerk()) return;
    if (syncEditMode) return;

    const candidate = syncCodeNormalisieren(currentSyncCode || localStorage.getItem(SYNC_CODE_KEY) || "");
    if (!istGueltigerSyncCode(candidate) || istReservierterSyncCode(candidate)) return;

    if (currentSyncCode !== candidate) {
        authStatusSetzen("Online erkannt. Verbinde mit gespeichertem Code...");
        await syncCodeAnwenden(candidate, false, { allowOccupied: true });
    }

    if (currentSyncCode === candidate) {
        authStatusSetzen("Online erkannt. Synchronisiere...");
        await syncRemoteIfNeeded();
    }
}

function _onSyncFocus() {
    if (keinNetzwerk()) return;
    void refreshFromRemoteIfChanged();
}
function _onSyncOnline() {
    void autoWiederverbinden().catch(err => console.warn("autoWiederverbinden fehlgeschlagen:", err));
    void refreshFromRemoteIfChanged();
}
function _onSyncVisibilityChange() {
    if (!document.hidden && !keinNetzwerk()) void refreshFromRemoteIfChanged();
}

function hintergrundSyncStarten() {
    if (!supabaseClient) return;
    if (hintergrundTimer) clearInterval(hintergrundTimer);

    hintergrundTimer = setInterval(() => {
        if (document.hidden) return;
        if (keinNetzwerk()) return;
        void refreshFromRemoteIfChanged();
    }, BACKGROUND_SYNC_INTERVAL_MS);

    window.removeEventListener("focus", _onSyncFocus);
    window.addEventListener("focus", _onSyncFocus);
    window.removeEventListener("online", _onSyncOnline);
    window.addEventListener("online", _onSyncOnline);
    document.removeEventListener("visibilitychange", _onSyncVisibilityChange);
    document.addEventListener("visibilitychange", _onSyncVisibilityChange);
}


/* --- Update-Mechanismus ----------------------------------------- */

async function updateErzwingen() {
    if (btnForceUpdate) btnForceUpdate.disabled = true;
    updateButtonVerfuegbarSetzen(false);
    syncStatusSetzen("Update: wird angewendet...", "warn");

    try {
        // 1. Alle Caches löschen
        if ("caches" in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map(key => caches.delete(key)));
        }

        // 2. Service Worker deregistrieren
        if ("serviceWorker" in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            await Promise.all(registrations.map(r => r.unregister()));
        }

        // 3. Seite neu laden – holt alle Dateien frisch vom Server
        window.location.reload(true);
    } catch (err) {
        console.warn("Update fehlgeschlagen:", err);
        syncStatusSetzen("Update fehlgeschlagen", "offline");
        if (btnForceUpdate) btnForceUpdate.disabled = false;
    }
}

function updateButtonVerfuegbarSetzen(verfuegbar) {
    if (!btnForceUpdate) return;
    btnForceUpdate.classList.toggle("update-available", verfuegbar);
}

async function serverVersionLaden() {
    try {
        const res = await fetch(`./version.json?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return null;
        const data = await res.json();
        return String(data.version || "").trim();
    } catch {
        return null;
    }
}

async function autoUpdatePruefen() {
    try {
        const serverVersion = await serverVersionLaden();
        if (!serverVersion) return;
        const hasUpdate = serverVersion !== APP_VERSION;
        updateButtonVerfuegbarSetzen(hasUpdate);
        if (hasUpdate) {
            syncStatusSetzen("Update verfuegbar", "warn");
            // SW-Update anstoßen → skipWaiting → controllerchange → Reload
            const reg = await navigator.serviceWorker.getRegistration();
            if (reg) reg.update().catch(() => {});
        }
    } catch (err) {
        console.warn("Auto-Update-Pruefung fehlgeschlagen:", err);
    }
}

function autoUpdateEinrichten() {
    if (!("serviceWorker" in navigator)) return;
    if (updatePruefTimer) clearInterval(updatePruefTimer);

    updatePruefTimer = setInterval(() => {
        if (document.hidden) return;
        void autoUpdatePruefen();
    }, AUTO_UPDATE_CHECK_INTERVAL_MS);

    if (!autoUpdateEinrichten._listenersRegistered) {
        autoUpdateEinrichten._listenersRegistered = true;
        window.addEventListener("focus", () => void autoUpdatePruefen());
        window.addEventListener("online", () => void autoUpdatePruefen());
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) void autoUpdatePruefen();
        });
    }

    void autoUpdatePruefen();
}


/* --- Debug ------------------------------------------------------ */

function syncDebugAktualisieren() {
    if (!syncDebug) return;
    if (!debugEnabled) {
        syncDebug.hidden = true;
        return;
    }
    syncDebug.hidden = false;
    const uid = shortUserId(supabaseUserId);
    const syncText = lastSyncAt || "-";
    const code = currentSyncCode || "-";
    syncDebug.textContent = `debug code=${code} uid=${uid} lastSync=${syncText}`;
}
