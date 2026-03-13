/* ======================
   UI.JS
   DOM-Elemente, Benutzeroberfläche, Eingabe, Sprache, Foto, Modus.
====================== */

/* --- DOM-Elemente ----------------------------------------------- */

const liste = document.getElementById("liste");

const btnErfassen    = document.getElementById("btnErfassen");
const btnErledigt    = document.getElementById("btnErledigt");
const btnExport      = document.getElementById("btnExport");
const btnForceUpdate = document.getElementById("btn-force-update");
const syncCodeCompact    = document.getElementById("sync-code-compact");
const btnSyncCodeDisplay = document.getElementById("btn-sync-code-display");
const btnSyncCodeShare   = document.getElementById("btn-sync-code-share");
const btnSyncConnect     = document.getElementById("btn-sync-connect");
const versionBadge   = document.getElementById("version-badge");
const syncStatus     = document.getElementById("sync-status");
const syncDebug      = document.getElementById("sync-debug");
const authBar        = document.getElementById("auth-bar");
const syncCodeInput  = document.getElementById("sync-code");
const btnSyncApply   = document.getElementById("btn-sync-apply");
const authStatus     = document.getElementById("auth-status");

const multiInput       = document.getElementById("multi-line-input");
const multiAdd         = document.getElementById("add-all-button");
const dueDateInput     = document.getElementById("due-date-input");
const btnPhotoOcr      = document.getElementById("btn-photo-ocr");
const photoOcrInput    = document.getElementById("photo-ocr-input");
const btnClearInput    = document.getElementById("btn-clear-input");
const btnNewLine       = document.getElementById("newline-button");
const btnMic           = document.getElementById("mic-button");
const micStatus        = document.getElementById("mic-status");
const inputErrorStatus = document.getElementById("input-error-status");
const imageViewer      = document.getElementById("image-viewer");
const imageViewerImg   = document.getElementById("image-viewer-img");
const btnImageViewerClose = document.getElementById("btn-image-viewer-close");
const photoCaptionArea    = document.getElementById("photo-caption-area");
const photoCaptionPreview = document.getElementById("photo-caption-preview");
const photoCaptionText    = document.getElementById("photo-caption-text");
const btnPhotoCaptionSave = document.getElementById("btn-photo-caption-save");
const btnPhotoCaptionCancel = document.getElementById("btn-photo-caption-cancel");
const helpViewer          = document.getElementById("help-viewer");
const btnHelpViewerClose  = document.getElementById("btn-help-viewer-close");
const btnHelp             = document.getElementById("btn-help");

const SpeechRecognitionCtor =
    window.SpeechRecognition || window.webkitSpeechRecognition;

let modus = MODUS_ERFASSEN;

if (authBar) authBar.hidden = true;


/* --- Status-Anzeigen -------------------------------------------- */

function syncStatusSetzen(text, tone = "offline") {
    if (!syncStatus) return;
    syncStatus.textContent = text;
    syncStatus.classList.remove("ok", "warn", "offline");
    syncStatus.classList.add(tone);
}

function authStatusSetzen(text) {
    if (!authStatus) return;
    authStatus.textContent = text;
}

function eingabeFehlerSetzen(text) {
    if (!inputErrorStatus) return;
    inputErrorStatus.textContent = String(text || "").trim();
}


/* --- Sortierung -------------------------------------------------- */

function entryLabelFromData(entryLike) {
    const text = String(entryLike?.text || entryLike?.title || "").trim();
    const note = String(entryLike?.note || "").trim();
    if (!text || isPhotoEntryText(text)) return text;
    return note ? `${text} — ${note}` : text;
}

function getEntryTimestamp(entryLike) {
    const fromEntryDate = normalizeDateIso(entryLike?.entryDate || entryLike?.entry_date);
    if (fromEntryDate) return Date.parse(fromEntryDate);
    const fromCreatedAt = normalizeDateIso(entryLike?.createdAt || entryLike?.created_at);
    if (fromCreatedAt) return Date.parse(fromCreatedAt);
    const fromItemId = extractDateFromItemId(entryLike?.itemId || entryLike?.item_id);
    if (fromItemId) return Date.parse(fromItemId);
    return 0;
}

function sortListByReminderDate() {
    const daten = normalizeListData(datenAusListeLesen());
    if (!daten.length) return false;

    const offene = daten.filter(e => !e.erledigt);
    const erledigte = daten.filter(e => e.erledigt);
    const collator = new Intl.Collator("de", { sensitivity: "base" });

    const sortFn = (a, b) => {
        const aDue = a.dueDate || "";
        const bDue = b.dueDate || "";
        if (aDue && bDue) return aDue < bDue ? -1 : aDue > bDue ? 1 : 0;
        if (aDue && !bDue) return -1;
        if (!aDue && bDue) return 1;
        const tsDiff = getEntryTimestamp(a) - getEntryTimestamp(b);
        if (tsDiff !== 0) return tsDiff;
        return collator.compare(entryLabelFromData(a), entryLabelFromData(b));
    };
    offene.sort(sortFn);
    erledigte.sort(sortFn);

    const sortierte = [...offene, ...erledigte].map((e, index) => ({
        ...e,
        position: index
    }));

    datenInListeSchreiben(sortierte);
    speichernLokal(sortierte);
    return true;
}


/* --- Listen-Rendering ------------------------------------------- */

const longPressTimers = new WeakMap();

function datenAusListeLesen() {
    const daten = [];
    liste.querySelectorAll("li").forEach((li, index) => {
        const itemId = String(li.dataset.itemId || "").trim() || generateItemId();
        const createdAt = normalizeDateIso(li.dataset.createdAt) || extractDateFromItemId(itemId) || new Date().toISOString();
        const entryDate = normalizeDateIso(li.dataset.entryDate || li.dataset.createdAt) || createdAt;
        const title = String(li.dataset.title || li.dataset.rawText || li.dataset.text || "").trim();
        const note = String(li.dataset.note || "").trim();
        const dueDate = String(li.dataset.dueDate || "").trim().slice(0, 10);
        li.dataset.itemId = itemId;
        li.dataset.createdAt = createdAt;
        li.dataset.entryDate = entryDate;
        li.dataset.title = title;
        li.dataset.note = note;
        li.dataset.dueDate = dueDate;
        daten.push({
            itemId,
            text: li.dataset.rawText || li.dataset.text || title,
            title,
            note,
            erledigt: li.classList.contains("erledigt"),
            createdAt,
            entryDate,
            dueDate,
            position: index
        });
    });
    return daten;
}

function datenInListeSchreiben(daten) {
    liste.innerHTML = "";
    daten.forEach(e => eintragAnlegen(e));
}

function eintragAnlegen(text, erledigt = false, itemId = generateItemId(), createdAt = "") {
    const li = document.createElement("li");
    const inputIsObject = typeof text === "object" && text !== null;
    const rawText = String(inputIsObject ? (text.text || text.title || "") : (text || ""));
    const entryTitle = String(inputIsObject ? (text.title || rawText) : rawText).trim();
    const entryNote = String(inputIsObject ? (text.note || "") : "").trim();
    const inputItemId = inputIsObject ? text.itemId : itemId;
    const inputCreatedAt = inputIsObject ? (text.createdAt || text.entryDate) : createdAt;
    const inputErledigt = inputIsObject ? Boolean(text.erledigt) : erledigt;
    const normalizedItemId = String(inputItemId || "").trim() || generateItemId();
    const normalizedCreatedAt =
        normalizeDateIso(inputCreatedAt) || extractDateFromItemId(normalizedItemId) || new Date().toISOString();
    const normalizedEntryDate =
        normalizeDateIso(inputIsObject ? (text.entryDate || text.createdAt) : createdAt)
        || normalizedCreatedAt;
    const normalizedDueDate = inputIsObject ? String(text.dueDate || "").trim().slice(0, 10) : "";

    li.dataset.itemId = normalizedItemId;
    li.dataset.rawText = rawText;
    li.dataset.text = rawText;
    li.dataset.title = entryTitle;
    li.dataset.note = entryNote;
    li.dataset.createdAt = normalizedCreatedAt;
    li.dataset.entryDate = normalizedEntryDate;
    li.dataset.dueDate = normalizedDueDate;

    if (rawText.startsWith(IMAGE_ENTRY_PREFIX)) {
        const imageSrc = rawText.slice(IMAGE_ENTRY_PREFIX.length);
        const wrapper = document.createElement("div");
        wrapper.className = "list-photo-item";

        const thumb = document.createElement("img");
        thumb.className = "list-photo-thumb";
        thumb.src = imageSrc;
        thumb.alt = "Fotoeintrag";

        const openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.className = "list-photo-open";
        openBtn.textContent = "Foto öffnen";
        openBtn.onclick = event => {
            event.stopPropagation();
            bildViewerOeffnen(imageSrc);
        };

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "list-photo-delete";
        deleteBtn.textContent = "Löschen";
        deleteBtn.onclick = event => {
            event.stopPropagation();
            li.remove();
            speichern(true);
            mikStatusSetzen("Foto gelöscht.");
        };

        thumb.onclick = event => {
            event.stopPropagation();
            bildViewerOeffnen(imageSrc);
        };

        wrapper.appendChild(thumb);

        const photoControls = document.createElement("div");
        photoControls.className = "list-photo-controls";
        photoControls.appendChild(openBtn);
        photoControls.appendChild(deleteBtn);

        if (entryNote) {
            const noteSpan = document.createElement("span");
            noteSpan.className = "list-photo-note";
            noteSpan.textContent = entryNote;
            photoControls.appendChild(noteSpan);
        }

        wrapper.appendChild(photoControls);
        li.appendChild(wrapper);
    } else {
        const textWrap = document.createElement("span");
        textWrap.className = "list-item-text";

        const titleSpan = document.createElement("span");
        titleSpan.className = "list-item-title";
        titleSpan.textContent = entryTitle;
        textWrap.appendChild(titleSpan);

        if (entryNote) {
            const noteSpan = document.createElement("span");
            noteSpan.className = "list-item-note";
            noteSpan.textContent = entryNote;
            textWrap.appendChild(noteSpan);
        }

        li.appendChild(textWrap);
    }

    const dateSpan = document.createElement("span");
    dateSpan.className = "list-item-date";
    if (normalizedDueDate) {
        dateSpan.textContent = formatDueDate(normalizedDueDate);
        if (!inputErledigt) {
            const today = getTodayDateString();
            if (normalizedDueDate < today) li.classList.add("overdue");
            else if (normalizedDueDate === today) li.classList.add("due-today");
        }
    } else {
        dateSpan.textContent = formatEntryDate(normalizedEntryDate);
    }
    li.appendChild(dateSpan);

    if (inputErledigt) li.classList.add("erledigt");

    const cancelLongPress = () => {
        const timers = longPressTimers.get(li);
        if (!timers) return;
        clearTimeout(timers.activate);
        longPressTimers.delete(li);
        li.classList.remove("pending");
    };

    li.addEventListener("pointerdown", e => {
        if (modus !== MODUS_ERLEDIGT) return;
        e.preventDefault();
        li.setPointerCapture(e.pointerId);
        cancelLongPress();

        const timers = { activate: null };
        longPressTimers.set(li, timers);
        li.classList.add("pending");

        timers.activate = setTimeout(() => {
            if (!longPressTimers.has(li)) return;
            longPressTimers.delete(li);
            li.classList.remove("pending");
            if (li.classList.contains("erledigt")) {
                li.classList.remove("erledigt");
            } else {
                li.classList.add("erledigt");
            }
            sortListByReminderDate();
            speichern(true);
        }, 500);
    });

    li.addEventListener("pointerup",     cancelLongPress);
    li.addEventListener("pointercancel", cancelLongPress);
    li.addEventListener("contextmenu",   e => e.preventDefault());

    inputErledigt
        ? liste.appendChild(li)
        : liste.insertBefore(li, liste.firstChild);
}


/* --- Modus ------------------------------------------------------ */

function modusSetzen(neu) {
    const vorher = modus;
    modus = neu;

    if (btnErfassen) btnErfassen.classList.toggle("active", modus === MODUS_ERFASSEN);
    if (btnErledigt) btnErledigt.classList.toggle("active", modus === MODUS_ERLEDIGT);
    document.body.classList.toggle("modus-erledigt", modus === MODUS_ERLEDIGT);
    if (syncCodeCompact) syncCodeCompact.hidden = modus !== MODUS_ERFASSEN;
    if (authBar) authBar.hidden = !(modus === MODUS_ERFASSEN && syncEditMode);

    if (vorher !== MODUS_ERLEDIGT && neu === MODUS_ERLEDIGT) {
        if (sortListByReminderDate()) speichern();
    }

    if (vorher === MODUS_ERLEDIGT && neu === MODUS_ERFASSEN) {
        liste.querySelectorAll("li.erledigt").forEach(li => li.remove());
        speichern(true);
    }
}

if (btnErfassen) btnErfassen.onclick = () => modusSetzen(MODUS_ERFASSEN);
if (btnErledigt) btnErledigt.onclick = () => modusSetzen(MODUS_ERLEDIGT);


/* --- Viewer ----------------------------------------------------- */

function bildViewerOeffnen(src) {
    if (!imageViewer || !imageViewerImg) return;
    imageViewerImg.src = src;
    imageViewer.hidden = false;
}

function bildViewerSchliessen() {
    if (!imageViewer || !imageViewerImg) return;
    imageViewer.hidden = true;
    imageViewerImg.src = "";
}

function hilfeViewerOeffnen() {
    if (!helpViewer) return;
    helpViewer.hidden = false;
}

function hilfeViewerSchliessen() {
    if (!helpViewer) return;
    helpViewer.hidden = true;
}

if (btnImageViewerClose) btnImageViewerClose.onclick = bildViewerSchliessen;
if (imageViewer) {
    imageViewer.onclick = event => {
        if (event.target === imageViewer) bildViewerSchliessen();
    };
}
if (btnHelp) btnHelp.onclick = hilfeViewerOeffnen;
if (btnHelpViewerClose) btnHelpViewerClose.onclick = hilfeViewerSchliessen;
if (helpViewer) {
    helpViewer.onclick = event => {
        if (event.target === helpViewer) hilfeViewerSchliessen();
    };
}


/* --- Eingabe-Größe ---------------------------------------------- */

function autoResize() {
    if (!multiInput) return;
    multiInput.style.height = "auto";
    multiInput.style.height = multiInput.scrollHeight + "px";
}

function fokusInputAmEnde() {
    const pos = multiInput.value.length;
    multiInput.setSelectionRange(pos, pos);
}

if (multiInput) multiInput.addEventListener("input", autoResize);
if (multiInput) {
    multiInput.addEventListener("keydown", event => {
        if (event.key !== "Enter" || event.isComposing) return;
        event.preventDefault();
        const start = multiInput.selectionStart;
        const end = multiInput.selectionEnd;
        const text = multiInput.value;
        multiInput.value = text.slice(0, start) + "\n" + text.slice(end);
        const nextPos = start + 1;
        multiInput.setSelectionRange(nextPos, nextPos);
        autoResize();
    });
}


/* --- Mehrzeilen-Eingabe ------------------------------------------ */

function mehrzeilenSpeichern() {
    const text = multiInput.value.trim();
    if (!text) return;

    const dueDate = dueDateInput ? String(dueDateInput.value || "").trim() : "";
    text.split("\n")
        .map(l => l.trim())
        .filter(Boolean)
        .forEach(item => eintragAnlegen({ text: item, dueDate }));

    speichern();
    multiInput.value = "";
    autoResize();
    if (dueDateInput) { dueDateInput.value = ""; dueDateButtonAktualisieren(); }
    multiInput.blur();

    if (isListening) {
        finalTranscript = "";
        latestTranscript = "";
        skipAutoSaveForCurrentBuffer = true;
        ignoreResultsUntil = Date.now() + 500;
        restartMicAfterManualCommit = true;
        clearTimeout(micSessionTimer);
        recognition.stop();
        mikStatusSetzen("Eintrag gespeichert, Mikro wird neu gestartet...");
    }
}

function clearInputBuffer(stopDictation = false) {
    multiInput.value = "";
    autoResize();

    finalTranscript = "";
    latestTranscript = "";
    skipAutoSaveForCurrentBuffer = true;
    ignoreResultsUntil = Date.now() + 700;

    if (stopDictation && isListening && recognition) {
        restartMicAfterManualCommit = false;
        clearTimeout(micSessionTimer);
        recognition.stop();
        mikStatusSetzen("Eingabe geloescht.");
        return;
    }

    if (isListening) mikStatusSetzen("Eingabe geloescht. Bitte weiter sprechen...");
    else mikStatusSetzen("Eingabe geloescht.");
}

if (multiAdd) multiAdd.onclick = mehrzeilenSpeichern;

/* --- Fälligkeitsdatum-Button ------------------------------------ */

function dueDateButtonAktualisieren() {
    const btn = document.getElementById("btn-due-date");
    if (!btn || !dueDateInput) return;
    const hasDate = Boolean(dueDateInput.value);
    btn.classList.toggle("has-date", hasDate);
    btn.title = hasDate
        ? `Fällig: ${formatDueDate(dueDateInput.value)} (tippen zum Ändern)`
        : "Fälligkeitsdatum setzen";
}

if (dueDateInput) {
    dueDateInput.addEventListener("change", dueDateButtonAktualisieren);
}

if (btnClearInput) {
    btnClearInput.onclick = () => clearInputBuffer(false);
}

if (btnNewLine) {
    btnNewLine.onclick = () => {
        if (!multiInput) return;
        multiInput.value += "\n";
        autoResize();
        multiInput.blur();
    };
}


/* --- Foto ------------------------------------------------------- */

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Datei konnte nicht gelesen werden."));
        reader.readAsDataURL(file);
    });
}

async function optimizePhotoDataUrl(dataUrl) {
    if (!String(dataUrl || "").startsWith("data:image/")) return dataUrl;
    try {
        const image = await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error("Bild konnte nicht geladen werden."));
            img.src = dataUrl;
        });
        const maxSide = 1280;
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return dataUrl;
        ctx.drawImage(image, 0, 0, width, height);
        const compressed = canvas.toDataURL("image/jpeg", 0.78);
        return compressed.length < dataUrl.length ? compressed : dataUrl;
    } catch {
        return dataUrl;
    }
}

let pendingPhotoSrc = "";

function photoCaptionBereich(show) {
    if (!photoCaptionArea) return;
    photoCaptionArea.hidden = !show;
    if (!show) {
        pendingPhotoSrc = "";
        if (photoCaptionPreview) photoCaptionPreview.src = "";
        if (photoCaptionText) photoCaptionText.value = "";
    }
}

async function addPhotoAsListItem(file) {
    if (!file) return;
    if (btnPhotoOcr) btnPhotoOcr.disabled = true;
    mikStatusSetzen("Foto wird geladen...");

    try {
        const imageSrc = await readFileAsDataUrl(file);
        const optimizedImageSrc = await optimizePhotoDataUrl(imageSrc);
        pendingPhotoSrc = optimizedImageSrc;
        if (photoCaptionPreview) photoCaptionPreview.src = optimizedImageSrc;
        if (photoCaptionText) { photoCaptionText.value = ""; }
        photoCaptionBereich(true);
        mikStatusSetzen("Beschreibung eingeben und Foto speichern.");
    } catch (err) {
        console.warn("Foto konnte nicht hinzugefuegt werden:", err);
        mikStatusSetzen("Foto konnte nicht gelesen werden.");
    } finally {
        if (btnPhotoOcr) btnPhotoOcr.disabled = false;
        if (photoOcrInput) {
            photoOcrInput.value = "";
            photoOcrInput.type = "";
            photoOcrInput.type = "file";
        }
    }
}

function photoCaptionSpeichern() {
    if (!pendingPhotoSrc) return;
    const note = photoCaptionText ? photoCaptionText.value.trim() : "";
    eintragAnlegen({ text: IMAGE_ENTRY_PREFIX + pendingPhotoSrc, note });
    speichern();
    photoCaptionBereich(false);
    mikStatusSetzen("Foto zur Liste hinzugefügt.");
}

if (btnPhotoCaptionSave) btnPhotoCaptionSave.onclick = photoCaptionSpeichern;
if (btnPhotoCaptionCancel) btnPhotoCaptionCancel.onclick = () => {
    photoCaptionBereich(false);
    mikStatusSetzen("Foto abgebrochen.");
};

if (btnPhotoOcr && photoOcrInput) {
    btnPhotoOcr.onclick = () => photoOcrInput.click();
    photoOcrInput.onchange = () => {
        const file = photoOcrInput.files?.[0];
        void addPhotoAsListItem(file);
    };
}


/* --- Mikrofon / Sprache ----------------------------------------- */

let recognition;
let isListening = false;
let finalTranscript = "";
let latestTranscript = "";
let micSessionTimer;
let skipAutoSaveForCurrentBuffer = false;
let ignoreResultsUntil = 0;
let restartMicAfterManualCommit = false;

function mikStatusSetzen(message = "") {
    if (!micStatus) return;
    micStatus.textContent = message;
}

function mikButtonSetzen(listening) {
    if (!btnMic) return;
    btnMic.classList.toggle("listening", listening);
    btnMic.setAttribute("aria-pressed", listening ? "true" : "false");
    btnMic.textContent = listening ? "⏹" : "🎤";
}

function eingabeMitDiktat(text) {
    if (!multiInput) return;
    multiInput.value = text;
    autoResize();
    if (document.activeElement === multiInput) fokusInputAmEnde();
}

function initRecognition() {
    if (!SpeechRecognitionCtor) return null;

    const r = new SpeechRecognitionCtor();
    r.lang = "de-DE";
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onstart = () => {
        isListening = true;
        finalTranscript = "";
        latestTranscript = "";
        skipAutoSaveForCurrentBuffer = false;
        if (Date.now() >= ignoreResultsUntil) ignoreResultsUntil = 0;
        restartMicAfterManualCommit = false;
        mikButtonSetzen(true);
        mikStatusSetzen("Spracheingabe aktiv (max. 30s)...");
        clearTimeout(micSessionTimer);
        micSessionTimer = setTimeout(() => {
            if (!isListening) return;
            mikStatusSetzen("Zeitlimit erreicht.");
            r.stop();
        }, MIC_SESSION_MS);
    };

    r.onresult = event => {
        if (!isListening) return;
        if (Date.now() < ignoreResultsUntil) return;
        let interimTranscript = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
            const part = event.results[i][0]?.transcript?.trim() || "";
            if (!part) continue;
            if (event.results[i].isFinal) finalTranscript += (finalTranscript ? " " : "") + part;
            else interimTranscript += (interimTranscript ? " " : "") + part;
        }
        const combined = [finalTranscript, interimTranscript].filter(Boolean).join(" ").trim();
        latestTranscript = combined;
        if (combined) skipAutoSaveForCurrentBuffer = false;
        eingabeMitDiktat(combined);
    };

    r.onerror = event => {
        clearTimeout(micSessionTimer);
        isListening = false;
        mikButtonSetzen(false);
        recognition = null;
        const errorText = {
            "not-allowed": "Mikrofon nicht erlaubt – bitte in Einstellungen erlauben.",
            "service-not-allowed": "Spracherkennung blockiert – bitte in Einstellungen erlauben.",
            "audio-capture": "Kein Mikrofon verfuegbar.",
            "network": "Netzwerkfehler bei Spracherkennung.",
            "no-speech": "Keine Sprache erkannt."
        }[event.error] || ("Spracherkennung-Fehler: " + event.error);
        mikStatusSetzen(errorText);
    };

    r.onend = () => {
        clearTimeout(micSessionTimer);
        isListening = false;
        mikButtonSetzen(false);
        if (restartMicAfterManualCommit) {
            restartMicAfterManualCommit = false;
            startRecognition();
            return;
        }
        if (skipAutoSaveForCurrentBuffer) {
            skipAutoSaveForCurrentBuffer = false;
            mikStatusSetzen("Spracheingabe beendet.");
            return;
        }
        const spokenText = finalTranscript.trim() || latestTranscript.trim();
        if (spokenText) {
            const currentValue = multiInput?.value?.trim() || "";
            if (multiInput && currentValue !== spokenText) {
                multiInput.value = currentValue ? `${currentValue}\n${spokenText}` : spokenText;
            }
            autoResize();
            if (multiInput) {
                multiInput.focus();
                fokusInputAmEnde();
            }
            mikStatusSetzen("Text erkannt. Mit Übernehmen speichern.");
            return;
        }
        if (!micStatus?.textContent) mikStatusSetzen("Keine Sprache erkannt.");
    };

    return r;
}

function startRecognition() {
    if (!recognition) return;
    mikStatusSetzen("Mikrofon wird gestartet...");
    try {
        recognition.start();
    } catch (error) {
        console.warn("Speech start error:", error);
        isListening = false;
        mikButtonSetzen(false);
        recognition = null;
        mikStatusSetzen("Mikrofon nicht bereit. Bitte erneut tippen.");
    }
}

function toggleDictation() {
    if (!SpeechRecognitionCtor) {
        mikStatusSetzen("Spracherkennung wird hier nicht unterstuetzt.");
        return;
    }
    if (!window.isSecureContext && !istLokalhost()) {
        mikStatusSetzen("Spracheingabe braucht HTTPS.");
        return;
    }
    if (!recognition && isListening) {
        isListening = false;
        mikButtonSetzen(false);
    }
    if (!recognition) recognition = initRecognition();
    if (!recognition) return;
    if (isListening) {
        clearTimeout(micSessionTimer);
        restartMicAfterManualCommit = false;
        recognition.stop();
        return;
    }
    startRecognition();
}

if (btnMic) btnMic.onclick = toggleDictation;


/* --- Export ----------------------------------------------------- */

if (btnExport) {
    btnExport.onclick = async () => {
        const textEntries = [...liste.querySelectorAll("li")]
            .map(li => ({
                erledigt: li.classList.contains("erledigt"),
                raw: String(li.dataset.rawText || li.dataset.text || "")
            }))
            .filter(item => item.raw && !item.raw.startsWith(IMAGE_ENTRY_PREFIX));

        const offeneLines = textEntries
            .filter(item => !item.erledigt)
            .map(item => "• " + item.raw);
        const erledigteLines = textEntries
            .filter(item => item.erledigt)
            .map(item => "✔ " + item.raw);

        const exportDate = new Intl.DateTimeFormat("de-AT", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric"
        }).format(new Date());

        const text = [
            "Erinnerungen",
            `Datum: ${exportDate}`,
            `Eintraege: ${textEntries.length}`,
            "────────────",
            "",
            "Offen",
            ...(offeneLines.length ? offeneLines : ["(keine offenen Eintraege)"]),
            "",
            "Erledigt",
            ...(erledigteLines.length ? erledigteLines : ["(keine erledigten Eintraege)"])
        ].join("\n");

        if (navigator.share) {
            try {
                await navigator.share({ title: "Erinnerungen", text });
                return;
            } catch (err) {
                if (err?.name === "AbortError") return;
            }
        }

        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            alert("Liste kopiert.");
        } else {
            alert(text);
        }
    };
}
