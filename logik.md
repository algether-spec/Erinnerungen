# Erinnerungen – Logik & Architektur

## Datei-Struktur

| Datei | Aufgabe |
|---|---|
| config.js | Konstanten, APP_VERSION, Keys |
| utils.js | Hilfsfunktionen, Fehlermeldungen (`syncFehlerHinweis`) |
| supabase.js | Supabase-Client, Auth, Mitgliedschaft, Lesen/Schreiben |
| sync.js | Sync-Logik (Drei-Wege-Abgleich), Rollen, Update |
| ui.js | DOM, Eingabe, Rendering |
| app.js | Einstiegspunkt, Startreihenfolge |
| service-worker.js | Cache, PWA, Manifest |
| supabase/schema.sql | Basis-Schema (allein unsicher, siehe Sicherheit) |
| supabase/security_3_reminders.sql | Regeln für `reminder_items` und `sync_codes` |

---

## Sync-Logik

### Ablauf

1. App startet → lokale Liste wird **sofort** angezeigt (`ladenLokal()`)
2. Code-Einrichtung (`syncCodeUiEinrichten`) läuft: Rolle lesen, Join-Link/Einladung einlösen, `use_sync_code`
3. **Erst danach** `laden()` → `syncRemoteIfNeeded()` (vorher ist der Code und damit die Mitgliedschaft unklar)
4. Änderungen → `speichern()` → `syncRemoteIfNeeded()`
5. Hintergrund-Timer (alle 4 s) → `refreshFromRemoteIfChanged()`

### Drei-Wege-Abgleich (`einmalAbgleichen` / `listenAbgleichen`)

Verglichen werden drei Stände:

- **lokal**: die Liste im DOM
- **remote**: die Zeilen auf dem Server
- **Basis**: IDs, die beim letzten erfolgreichen Abgleich auf dem Server *und* lokal waren (localStorage `erinnerungen-sync-basis`, gehört zum aktuellen Code)

| lokal | remote | in Basis | Bedeutung | Aktion |
|---|---|---|---|---|
| ja | ja | – | vorhanden | lokale Version gilt, hochladen falls geändert |
| ja | nein | nein | lokal neu | hochladen |
| ja | nein | ja | auf anderem Gerät gelöscht | lokal entfernen |
| nein | ja | nein | auf anderem Gerät neu | lokal hinzufügen |
| nein | ja | ja | lokal gelöscht | **gezielt** auf dem Server löschen |

- Hochgeladen werden nur neue/geänderte Einträge (`geaenderteEintraege`)
- Gelöscht wird nur per ID-Liste (`eintraegeRemoteLoeschen`), nie pauschal
- **Ohne Basis** (erster Start nach Update, Code-Wechsel, nach Speicherfehler): Server-Stand gilt, wenn er nicht leer ist; sonst wird die lokale Liste hochgeladen

### Regeln für die Basis

- Basis wird nur gespeichert, wenn auch die lokale Liste gespeichert werden konnte (`lokalMitBasisSpeichern`, `syncBasisSetzen`)
- Schlägt `speichernLokal` fehl (z. B. localStorage voll durch Fotos) → Basis wird verworfen (`lokalSpeicherFehler`). Sonst könnte nach einem Neustart ein Eintrag fälschlich als „lokal gelöscht“ gelten und auf dem Server gelöscht werden
- Ändert der Nutzer während eines Abgleichs etwas, wird die Liste nicht überschrieben; die Basis wird auf die lokal bekannten Einträge gesetzt, die jetzt auf dem Server sind, und der Abgleich läuft erneut

### Hintergrund-Refresh (`refreshFromRemoteIfChanged`)

- Bei ungespeicherten lokalen Änderungen (`localDirty`) → stattdessen `syncRemoteIfNeeded()` (wiederholt so auch fehlgeschlagene Abgleiche, z. B. nach Offline)
- Sonst Server-Stand übernehmen und Basis aktualisieren
- Antwort wird verworfen, wenn sich lokal inzwischen etwas geändert hat (`lokaleAenderungen`-Zähler) oder ein Abgleich läuft

### Wichtige Flags

- `localDirty` — lokale Änderungen noch nicht auf dem Server
- `lokaleAenderungen` — Zähler, steigt bei jedem `speichern()`; erkennt veraltete Antworten
- `lokalSpeicherFehler` — letzter localStorage-Schreibversuch fehlgeschlagen
- `remoteSyncInFlight` / `remoteSyncQueued` — kein paralleler Abgleich, keiner geht verloren
- `remotePullInFlight` — kein paralleler Hintergrund-Refresh

### Mitgliedschaft (`mitgliedschaftSicherstellen`)

- Ohne Mitgliedschaft liefert die Datenbank eine **leere Liste statt eines Fehlers**
- Deshalb vor jedem Lesen/Schreiben: `use_sync_code` einmal pro User + Code
- Wichtig, weil Einkaufsliste und Erinnerungen auf derselben Domain laufen und sich die anonyme Supabase-Anmeldung teilen – der User kann sich im laufenden Betrieb ändern

---

## Bekannte Bugs & Fixes

### ✅ Fix: Gelöschte Einträge kommen zurück (v1.0.54)

**Problem:** Gelöschte Einträge tauchten immer wieder auf, vor allem mit mehreren Geräten oder nach Offline-Löschen.

**Ursache:** Die App wusste nicht, was beim letzten Abgleich auf dem Server war. Fehlte ein Eintrag, konnte sie „gelöscht“ nicht von „neu“ unterscheiden und hat ihn wieder hochgeladen. `speichern(true)` überschrieb außerdem den ganzen Server-Stand mit der lokalen Liste – ein Gerät mit älterem Stand löschte so neue Einträge anderer Geräte.

**Fix:** Drei-Wege-Abgleich mit Basis (siehe oben). `mergeListConflict` und `speichernRemote` wurden ersetzt.

### ✅ Fix: Liste wurde nach Anmeldungswechsel geleert (v1.0.52)

**Ursache:** Nach `security_3` sieht ein Nicht-Mitglied eine leere Liste; der Hintergrund-Sync hat die lokale Liste damit überschrieben.

**Fix:** `mitgliedschaftSicherstellen()` + `laden()` erst nach der Code-Einrichtung.

### ✅ Fix: Erledigt-Markierung wird nach Sekunden zurückgesetzt (v1.0.45)

Damals: `mergeListConflict()` bevorzugte Remote-Daten. Heute gilt beim Abgleich immer die lokale Version eines Eintrags.

---

## Service Worker / PWA Update

### Warum Updates manchmal nicht ankommen

- SW läuft in eigenem Thread, überlebt Seitenreloads
- Bis zu 4 Cache-Schichten: SW Cache, Browser Cache, HTTP Cache, CDN
- Alter SW kann aktiv bleiben während neuer schon installiert ist

### SW-Strategie

- Install lädt alle Dateien mit `cache: "reload"` → umgeht den HTTP-Cache (GitHub Pages cacht 10 Min.), sonst könnte eine alte `supabase.js` im neuen Cache landen
- Caches pro Bereich: `erinnerungen-v…` (Produktion), `erinnerungen-dev-v…` (/dev)
- Beim Aktivieren werden nur **eigene** alte Versions-Caches gelöscht – nie die der Einkaufsliste (gleiche Domain) oder von /dev
- `version.json` und `service-worker.js` → immer frisch vom Netz
- Navigation → Netz zuerst, sonst Cache (offline startbar)
- Andere Dateien → Cache first, dann Netz
- `manifest.json` → dynamisch mit aktuellem Install-Kontext

### Update erzwingen (manuell)

Der "Update erzwingen"-Button in der App:

1. Löscht alle Caches
2. Deregistriert den Service Worker
3. Lädt die Seite neu → holt alles frisch vom Server

---

## Rollen & Geräte

| Rolle | Bedeutung |
|---|---|
| `hauptgeraet` | Erstellt den Sync-Code, kann teilen |
| `gast` | Tritt über Einladungslink bei |

- Rolle wird in Supabase `device_roles` gespeichert (nur für Mitglieder des Codes lesbar)
- Join-Link `#join=<token>` → wird serverseitig per `redeem_join_token` eingelöst (trägt auch die Mitgliedschaft ein)
- Legacy: `#invite=<device_id>` → per `redeem_legacy_invite`
- Join-Token läuft nach 30 Tagen ab
- Rollen sind nur Oberfläche – der Server unterscheidet nicht zwischen Haupt­gerät und Gast

---

## Sicherheit (gemeinsame Supabase-Datenbank mit der Einkaufsliste)

- Zugriff auf Einträge nur für Mitglieder eines Codes (`has_sync_membership`)
- **Stand 22.11.2026: alle drei Skripte sind aktiv** (getestet: Liste, Fotos, zweites Gerät, Teilen-Links beider Apps)
  1. `security_1.sql` (Einkaufsliste-Repo)
  2. `security_3_reminders.sql` – `reminder_items` (4 Regeln) und `sync_codes` (keine Regeln, nur über RPCs)
  3. `security_2.sql` (Einkaufsliste-Repo) – `device_join_tokens`, `sync_invites`, `device_roles` (je 3 Regeln, kein DELETE)
- Erwarteter Zustand: nur Regeln für `{authenticated}` mit `has_sync_membership`, keine mit `{public}`
- Beide Skripte löschen zuerst **alle** Regeln ihrer Tabellen (alte offene Regeln mit Leerzeichen im Namen bzw. `shopping_items_*_by_code` waren neben den neuen noch aktiv), prüfen sich am Ende selbst und rollen bei Abweichung alles zurück
- Ausführen: SQL-Editor → nichts markieren → komplett ausführen; mehrfaches Ausführen ist unschädlich
- `schema.sql` allein setzt die alten, offenen Regeln → danach immer die security-Skripte erneut ausführen

---

## Deployment

- Push auf `dev` → GitHub Action kopiert nach `main/dev/` → https://algether-spec.github.io/Erinnerungen/dev/
- `rsync --checksum`: vergleicht den Inhalt (reine Versionsänderungen haben gleiche Dateigröße und wurden früher übersprungen)
- Push auf `main` → GitHub Pages (Produktion)
