/* ======================
   SUPABASE.JS
   Datenbankverbindung, Auth, Realtime und Remote-Queries.
====================== */

const hasSupabaseCredentials = Boolean(APP_CONFIG.supabaseUrl && APP_CONFIG.supabaseAnonKey);
const hasSupabaseLibrary = Boolean(
    window.supabase && typeof window.supabase.createClient === "function"
);
const supabaseClient = hasSupabaseCredentials && hasSupabaseLibrary
    ? window.supabase.createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseAnonKey)
    : null;

let supabaseReady = false;
let supabaseUserId = "";
let echtzeitKanal = null;
let echtzeitTimer = null;


/* --- Auth ------------------------------------------------------- */

async function authSicherstellen() {
    if (keinNetzwerk()) {
        eingabeFehlerSetzen("");
        syncStatusSetzen("Sync: Offline (lokal)", "offline");
        return false;
    }
    if (!supabaseClient) {
        eingabeFehlerSetzen("Supabase Client nicht initialisiert. config.js / Internet pruefen.");
        syncStatusSetzen("Sync: Offline (lokal)", "offline");
        return false;
    }
    if (supabaseReady && supabaseUserId) return true;

    try {
        syncStatusSetzen("Sync: Verbinde...", "warn");
        const sessionResult = await supabaseClient.auth.getSession();
        if (sessionResult?.error) throw sessionResult.error;
        let user = sessionResult?.data?.session?.user || null;

        if (!user) {
            const anonResult = await supabaseClient.auth.signInAnonymously();
            if (anonResult?.error) throw anonResult.error;
            user = anonResult?.data?.user || null;
        }

        if (!user?.id) {
            eingabeFehlerSetzen("Anonyme Anmeldung fehlgeschlagen. Supabase Auth/Anon-Login pruefen.");
            syncStatusSetzen("Anonyme Anmeldung fehlgeschlagen.", "offline");
            syncDebugAktualisieren();
            return false;
        }
        supabaseUserId = user.id;
        supabaseReady = true;
        echtzeitSyncStarten();
        eingabeFehlerSetzen("");
        syncStatusSetzen("Sync: Verbunden", "ok");
        syncDebugAktualisieren();
        return true;
    } catch (err) {
        console.warn("Supabase Auth nicht verfuegbar:", err);
        supabaseReady = false;
        supabaseUserId = "";
        echtzeitSyncStoppen();
        eingabeFehlerSetzen(syncFehlerHinweis(err));
        syncStatusSetzen(syncFehlerHinweis(err), "offline");
        syncDebugAktualisieren();
        return false;
    }
}


/* --- Realtime --------------------------------------------------- */

function echtzeitSyncStoppen() {
    if (echtzeitTimer) {
        clearTimeout(echtzeitTimer);
        echtzeitTimer = null;
    }
    if (!supabaseClient || !echtzeitKanal) return;
    try {
        supabaseClient.removeChannel(echtzeitKanal);
    } catch (err) {
        console.warn("Realtime-Channel konnte nicht entfernt werden:", err);
    }
    echtzeitKanal = null;
}

function echtzeitAktualisierungPlanen() {
    if (echtzeitTimer) clearTimeout(echtzeitTimer);
    echtzeitTimer = setTimeout(() => {
        if (typeof refreshFromRemoteIfChanged === "function") void refreshFromRemoteIfChanged();
    }, 250);
}

function echtzeitSyncStarten() {
    if (!supabaseClient || !currentSyncCode) return;
    echtzeitSyncStoppen();

    echtzeitKanal = supabaseClient
        .channel(`reminder_items_${currentSyncCode}`)
        .on(
            "postgres_changes",
            {
                event: "*",
                schema: "public",
                table: SUPABASE_TABLE,
                filter: `sync_code=eq.${currentSyncCode}`
            },
            () => {
                if (document.hidden) return;
                echtzeitAktualisierungPlanen();
            }
        )
        .subscribe(status => {
            if (status === "CHANNEL_ERROR") {
                console.warn("Realtime-Channel Fehler, nutze Polling weiter.");
                echtzeitSyncStoppen();
            }
        });
}


/* --- Device Roles ----------------------------------------------- */

async function geraetStatusAusSupabaseLaden(deviceId) {
    if (!supabaseClient || !deviceId) return null;
    if (!(await authSicherstellen())) return null;
    try {
        const { data, error } = await supabaseClient
            .from("device_roles")
            .select("rolle, sync_code")
            .eq("device_id", deviceId)
            .maybeSingle();
        if (error || !data?.rolle || !data?.sync_code) return null;
        return {
            rolle: String(data.rolle),
            syncCode: String(data.sync_code)
        };
    } catch (err) {
        console.warn("Geraetestatus-Lookup fehlgeschlagen:", err);
        return null;
    }
}

async function joinTokenInSupabaseSpeichern(joinToken, rolle, syncCode, options = {}) {
    if (!supabaseClient || !joinToken || !rolle || !syncCode) return null;
    if (!(await authSicherstellen())) return null;
    try {
        const expiresAt = Number.isFinite(options.expiresInMs)
            ? new Date(Date.now() + options.expiresInMs).toISOString()
            : null;
        const payload = {
            join_token: String(joinToken),
            rolle: String(rolle),
            sync_code: String(syncCode),
            created_by_device_id: String(options.createdByDeviceId || geraeteIdLaden()),
            updated_at: new Date().toISOString()
        };
        if (expiresAt) payload.expires_at = expiresAt;
        const { error } = await supabaseClient
            .from("device_join_tokens")
            .upsert(payload, { onConflict: "join_token" });
        if (error) throw error;
        return {
            joinToken: String(joinToken),
            rolle: String(rolle),
            syncCode: String(syncCode),
            expiresAt
        };
    } catch (err) {
        console.warn("Join-Token speichern fehlgeschlagen:", err);
        return null;
    }
}

// Löst den Token serverseitig ein: liefert Rolle + Code und trägt dieses
// Gerät als Mitglied ein. Direktes Lesen der Tabelle ist gesperrt.
async function joinTokenAusSupabaseLaden(joinToken) {
    if (!supabaseClient || !joinToken) return null;
    if (!(await authSicherstellen())) return null;
    try {
        const { data, error } = await supabaseClient.rpc("redeem_join_token", {
            p_token: String(joinToken)
        });
        if (error || !data?.rolle || !data?.sync_code) return null;
        if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) return null;
        return {
            rolle: String(data.rolle),
            syncCode: String(data.sync_code),
            expiresAt: data.expires_at ? String(data.expires_at) : ""
        };
    } catch (err) {
        console.warn("Join-Token-Lookup fehlgeschlagen:", err);
        return null;
    }
}

async function geraetStatusMitJoinTokenRegistrieren(deviceId, joinToken) {
    if (!supabaseClient || !deviceId || !joinToken) return null;
    const joinData = await joinTokenAusSupabaseLaden(joinToken);
    if (!joinData?.rolle || !joinData?.syncCode) return null;
    try {
        const { error } = await supabaseClient
            .from("device_roles")
            .upsert({
                device_id: String(deviceId),
                rolle: String(joinData.rolle),
                sync_code: String(joinData.syncCode),
                updated_at: new Date().toISOString()
            }, { onConflict: "device_id" });
        if (error) throw error;
        return {
            rolle: String(joinData.rolle),
            syncCode: String(joinData.syncCode)
        };
    } catch (err) {
        console.warn("Geraeteregistrierung via Join-Token fehlgeschlagen:", err);
        return null;
    }
}

// Löst eine ältere Einladung (#invite=<device_id>) serverseitig ein:
// liefert den Sync-Code und trägt dieses Gerät als Mitglied ein.
async function syncCodeAusEinladungLaden(deviceId) {
    if (!supabaseClient || !deviceId) return null;
    if (!(await authSicherstellen())) return null;
    try {
        const { data, error } = await supabaseClient.rpc("redeem_legacy_invite", {
            p_device_id: String(deviceId)
        });
        if (error || !data?.sync_code) return null;
        return String(data.sync_code);
    } catch (err) {
        console.warn("Einladungs-Lookup fehlgeschlagen:", err);
        return null;
    }
}

async function gastStatusAusLegacyEinladungLaden(deviceId) {
    const syncCode = await syncCodeAusEinladungLaden(deviceId);
    if (!syncCode) return null;
    return {
        rolle: "gast",
        syncCode: String(syncCode)
    };
}


/* --- Einladung -------------------------------------------------- */

async function einladungInDbSpeichern(code) {
    if (!supabaseClient) return;
    if (!istGueltigerSyncCode(code) || istReservierterSyncCode(code)) return;
    try {
        if (!(await authSicherstellen())) return;
        await supabaseClient.from("sync_invites").upsert({
            device_id: geraeteIdLaden(),
            sync_code: code,
            updated_at: new Date().toISOString()
        }, { onConflict: "device_id" });
    } catch (err) {
        console.warn("Einladung in DB speichern fehlgeschlagen:", err);
    }
}


/* --- Sync Code Usage -------------------------------------------- */

async function syncCodeRpcVerwenden(code, options = {}) {
    if (!supabaseClient) throw new Error("SUPABASE_CLIENT_MISSING");
    if (!istGueltigerSyncCode(code)) throw new Error("SYNC_CODE_FORMAT_INVALID");
    if (istReservierterSyncCode(code)) throw new Error("SYNC_CODE_RESERVED");
    if (!(await authSicherstellen())) throw new Error("AUTH_REQUIRED");

    const allowCreate = options.allowCreate !== false;
    const requireNew = options.requireNew === true;

    const { data, error } = await supabaseClient.rpc("use_sync_code", {
        p_code: String(code),
        p_allow_create: allowCreate,
        p_require_new: requireNew
    });
    if (error) throw error;
    // Server meldet "Code belegt/unbekannt" als JSON, damit Versuche gezählt werden
    if (data?.error) throw new Error(String(data.error));
    return data;
}

async function syncCodeNutzungAktualisieren(code) {
    if (!supabaseClient) return;
    if (!istGueltigerSyncCode(code)) return;
    if (istReservierterSyncCode(code)) return;
    await syncCodeRpcVerwenden(code, { allowCreate: true, requireNew: false });
}


/* --- Erinnerungen Data Operations ------------------------------- */

// Ohne Mitgliedschaft liefert die Datenbank eine LEERE Liste statt eines Fehlers.
// Das darf nie als "alles gelöscht" gelten → vor jedem Lesen/Schreiben sicherstellen,
// dass der aktuelle User (kann sich z. B. durch die mit der Einkaufsliste geteilte
// Anmeldung ändern) Mitglied des Codes ist. Einmal pro User + Code.
let mitgliedschaftBestaetigt = "";

async function mitgliedschaftSicherstellen() {
    if (!istGueltigerSyncCode(currentSyncCode) || istReservierterSyncCode(currentSyncCode)) return false;
    const { data } = await supabaseClient.auth.getSession();
    const userId = data?.session?.user?.id;
    if (!userId) return false;
    const key = `${userId}:${currentSyncCode}`;
    if (mitgliedschaftBestaetigt === key) return true;
    await syncCodeRpcVerwenden(currentSyncCode, { allowCreate: true, requireNew: false });
    mitgliedschaftBestaetigt = key;
    return true;
}

async function ladenRemote() {
    if (!supabaseClient) return null;
    if (!(await authSicherstellen())) return null;
    if (!(await mitgliedschaftSicherstellen())) return null;

    const { data, error } = await supabaseClient
        .from(SUPABASE_TABLE)
        .select("item_id, text, title, note, erledigt, position, created_at, entry_date, due_date")
        .eq("sync_code", currentSyncCode)
        .order("position", { ascending: true });

    if (error) throw error;
    if (!Array.isArray(data)) return [];

    return data.map((e, index) => ({
        itemId: String(e.item_id || "").trim() || generateItemId(),
        text: String(e.text || e.title || ""),
        title: String(e.title || e.text || ""),
        note: String(e.note || ""),
        erledigt: Boolean(e.erledigt),
        createdAt: normalizeDateIso(e.created_at) || extractDateFromItemId(e.item_id),
        entryDate: normalizeDateIso(e.entry_date || e.created_at) || extractDateFromItemId(e.item_id),
        dueDate: e.due_date ? String(e.due_date).slice(0, 10) : "",
        position: Number.isFinite(e.position) ? e.position : index
    }));
}

async function remoteBereitstellen() {
    if (!supabaseClient || !(await authSicherstellen())) throw new Error("network offline");
    if (!(await mitgliedschaftSicherstellen())) throw new Error("SYNC_CODE_NOT_JOINED");
}

function eintragAlsZeile(e) {
    return {
        sync_code: currentSyncCode,
        item_id: String(e.itemId),
        text: String(e.text || e.title || ""),
        title: String(e.title || e.text || ""),
        note: String(e.note || ""),
        erledigt: Boolean(e.erledigt),
        position: e.position,
        created_at: normalizeDateIso(e.createdAt) || extractDateFromItemId(e.itemId) || new Date().toISOString(),
        entry_date:
            normalizeDateIso(e.entryDate || e.createdAt)
            || extractDateFromItemId(e.itemId)
            || new Date().toISOString(),
        due_date: e.dueDate ? String(e.dueDate).slice(0, 10) : null
    };
}

// Neue oder geänderte Einträge hochladen
async function eintraegeHochladen(daten) {
    if (!daten.length) return;
    await remoteBereitstellen();
    const { error } = await supabaseClient
        .from(SUPABASE_TABLE)
        .upsert(daten.map(eintragAlsZeile), { onConflict: "sync_code,item_id" });
    if (error) throw error;
}

// Nur gezielt die angegebenen Einträge löschen – nie pauschal
async function eintraegeRemoteLoeschen(itemIds) {
    if (!itemIds.length) return;
    await remoteBereitstellen();
    const { error } = await supabaseClient
        .from(SUPABASE_TABLE)
        .delete()
        .eq("sync_code", currentSyncCode)
        .in("item_id", itemIds);
    if (error) throw error;
}


/* --- Geräte-Anzahl --------------------------------------------- */

async function geraeteAnzahlLaden(syncCode) {
    if (!supabaseClient || !syncCode) return 0;
    if (!(await authSicherstellen())) return 0;
    try {
        const { count, error } = await supabaseClient
            .from("device_roles")
            .select("device_id", { count: "exact", head: true })
            .eq("sync_code", syncCode);
        if (error) return 0;
        return count || 0;
    } catch (_) { return 0; }
}
