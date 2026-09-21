# CLAUDE.md — ioBroker.nut2

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker NUT Monitor** — Überwacht USV-Geräte über das Network UPS Tools (NUT) Protokoll. Persistente TCP-Verbindung, Multi-UPS per Instanz, dynamische State-Erstellung.

- **Version + Changelog:** current version in `io-package.json`; full internal dev history moved to `.claude/dev-history.md` (local, not auto-loaded). User-facing changelog: `README.md` + `io-package.json` news.
- **GitHub:** https://github.com/krobipd/ioBroker.nut2
- **npm:** https://www.npmjs.com/package/iobroker.nut2
- **Repository:** im Latest-Verzeichnis seit 2026-08-13 (PR #6373). Stable ist ein späterer, eigener Schritt.
- **Sentry:** `common.plugins.sentry` mit der gemeinsamen power-dreams-Adresse (ab v0.8.0, wie die übrigen Adapter) — kein eigenes npm-Paket, das Werkzeug kommt über den js-controller. README-Abzeichen + `## Sentry`-Abschnitt sind gate-erzwungen.
- **Runtime-Deps:** nur `@iobroker/adapter-core` (TCP via Node.js built-in `net`)
- **Test-Setup:** Tests unter `src/**/*.test.ts` direkt via **vitest**. `test/package.js` + `test/integration.js` bleiben mocha (`@iobroker/testing` ist mocha-only).
- **`@types/node` an `engines.node`-Min gekoppelt:** `^22.x` weil `engines.node: ">=22"`

## Architektur

```
src/main.ts                     → NutAdapter (Lifecycle, Polling, onStateChange für Commands/SetVar)
src/lib/
├── nut-client.ts               → NUT TCP Client (persistent, command queue, reconnect, auth, redactForLog für Credential-Echo)
├── nut-client.test.ts           → Mocked net.Socket tests
├── state-manager.ts            → ioBroker state CRUD (device/channel/state, createdIds-Cache, legacy cleanup, cleanupDeprecatedInfoStates, enrichStateMetadata, nutVarToStateId/nutVarToReadableName, sanitizeUpsName)
├── state-manager.test.ts
├── type-detector.ts            → NUT variable → ioBroker type/role/unit Mapping
├── type-detector.test.ts
├── status-parser.ts            → ups.status → 19 booleans + severity (0-4) + display string
├── status-parser.test.ts
├── coerce.ts                   → errText + Boundary-Validators (host, port, pollInterval, commandTimeout, parseNotifyTrigger)
├── coerce.test.ts
├── message-router.ts           → onMessage-Dispatcher (checkConnection + auth test, default-Branch-Contract)
├── message-router.test.ts
├── i18n.ts                     → tName(key) Wrapper über I18n.getTranslatedObject() (adapter-core I18n-Framework)
└── types.ts                    → TypeScript Interfaces + NUT-Konstanten
admin/i18n/<lang>.json          → Single-Source-of-Truth für UI- + State-Translations (297 Keys × 11 Sprachen)
docs/{en,de}/                   → Nutzerdoku im Repo (README/datapoints/faq), verlinkt über io-package.json common.docs
../scripts/sync-iopackage-from-i18n.py → regeneriert io-package.json:instanceObjects.common.name aus admin/i18n/ (zentral, source: admin-i18n)
```

## Design-Entscheidungen

_Jede Entscheidung steht hier als Regel-Satz; Beleg, Messung und Verlauf stehen wörtlich in `.claude/dev-history.md`, Eintrag „2026-09-21 — Design-Entscheidungen: Belege aus CLAUDE.md verlegt“ (lokal, gitignored)._

1. **Kein `node-nut` Dependency** — eigener NUT Client.
2. **Multi-UPS per Instanz** — via `LIST UPS` — alle UPS eines NUT-Servers automatisch entdeckt
3. **Persistente TCP-Verbindung** — behebt den Per-Poll-Reconnect-Overhead des alten Adapters
4. **Strikte Zahl-Heuristik** — statt GET TYPE — GET TYPE ist unzuverlässig (Eaton markiert alles als NUMBER).
5. **Status-Flags als einzelne Booleans** — 19 Flags (`status-parser.ts:STATUS_CATALOG`, single source).
6. **Commands hinter Safety-Gate** — `enableCommands` Checkbox verhindert versehentliches `load.off`.
7. **Network-Interface-Selector** — govee/hassemu-Pattern, wichtig für Multi-Homed-Server
8. **Dot-Depth-Sortierung** — Variables nach Punkttiefe sortiert, damit Parent-States vor Children existieren (battery.charge vor battery.charge.low)
9. **Dots→Dashes nach Channel** — `battery.charge.low` → stateId `ups0.battery.charge-low`.
10. **Auth-Failure = stay alive, yellow, no connections** — bei konfiguriertem username+password und abgelehnter Anmeldung: `client.destroy()` trennt TCP komplett (kein Reconnect, kein Polling, kein Datentransfer), Adapter bleibt am Leben mit `info.connection = false` (gelb in …
11. **Per-UPS info.reachable** — `indicator.reachable` Boolean mit `statusStates.onlineId` auf Device-Objekt (beszel-Pattern). v0.4.0 von `info.online` umbenannt — die Namens-Kollision mit dem `status.online`/OL-Flag (am Netz) verwirrte: `reachable` = …
12. **Legacy-Cleanup** — `cleanupLegacyObjects()` löscht Root-Level-Orphans (alter Adapter) und v0.1.0-Dot-Style-Objekte in einem Pass. **Ein Punkt-Stil-Objekt ist ein UMZUG, kein Wegfall** (v0.12.0): `ups0.battery.charge.low` ist derselbe …
13. **STARTTLS** — opt-in `useTls` verschlüsselt die Verbindung (Credentials sonst Klartext).
14. **Unified Retry-Loop im Client** — `start()` besitzt EINE Schleife: retryt den initialen Connect, reconnectet bei Drops, stoppt gelb bei TLS-Config-Fatal (`onFatal`).
15. **charging/discharging auch aus `battery.charger.status`** — USVen ohne CHRG/DISCHRG-Flags (z.B. Eaton Ellipse ECO, Apollon77-Issues #168/#97) füllen die Booleans über `battery.charger.status` (charging/discharging)
16. **`driver.flag.*` → read-only Boolean** — NUT-core on/off flag (`enabled`/`disabled`/`0`/`1` via `parseFlagValue`); read-only erzwungen, weil das einzige schreibbare (`allow_killpower`, `ST_FLAG_NUMBER`) ein `1/0`-SET-Token bräuchte, das der Boolean-Schreibpfad …
17. **on/off + enabled/disabled bleiben Enums (`common.states`), NICHT Boolean** — `onStateChange` mappt Boolean hart auf `yes`/`no`; ein Boolean-on-the-wire bräuchte per-Variable-Vokabular (`on` statt `yes`) → würde SET VAR für diese Variablen still brechen (die F1-Klasse).
18. **UPS-Namen-Sanitisierung** — `sanitizeUpsName` filtert Objekt-ID-verbotene Zeichen auf `[A-Za-z0-9_-]`; `discoveredUps` ist auf die sanitisierte ID gekeyt, der echte NUT-Name bleibt im Wert und wird für JEDEN Protokoll-Aufruf (LIST …
19. **Poll als setTimeout-Kette** — `scheduleNextPoll` plant den nächsten Poll erst nach Abschluss des vorigen (kein Overlap statt fixem `setInterval`); `pollTimer` bleibt zwischen Ticks definiert, damit der `armPollTimer`-Idempotenz-Guard + die …
20. **Credential-Redaction im Log** — `redactForLog` maskiert `USERNAME`/`PASSWORD` im Debug-Command-Echo (beides `protectedNative`/`encryptedNative`); der Wire-Write bleibt unredacted

21. **Nichts steht auf grün, wenn niemand liest (v0.8.0/v0.9.0)** — `<usv>.info.reachable` trägt via `statusStates.onlineId` das Symbol am Geräteobjekt, und ioBroker hält den letzten Wert ewig.
22. **Zusammenfassung `info.upsTotal`/`upsReachable`/`allUpsReachable` (v0.9.0)** — Flotten-Einheitlichkeit mit beszel; „reachable" statt „online", weil `status.online` schon das Netzstrom-Flag ist. **Statische `instanceObjects`** (existieren ab Installation, kein Erzeugen beim ersten Schreiben), Namen …
23. **`supportedMessages.stopInstance` ist RAUS — und wird beim Start im eigenen Instanzobjekt korrigiert (v0.9.0)** — mit dem Eintrag killt der Host den Prozess hart, `onUnload` läuft nie und der ganze Abschalt-Code ist tot (genau das war in v0.8.0 der Fall).

24. **`notify`-Trigger — die upsmon-Klingel (Issue #14, FernetMenta)** — NUT hat KEINEN Server-Push (net-protocol.txt 2.8.5 komplett geprüft: jede upsd-Zeile ist Antwort auf einen Befehl; auch TRACKING/FSD sind Poll).

25. **USV-Liste bei JEDEM Poll (v0.11.0)** — `LIST UPS` ist ein billiger Befehl gegen den upsd-RAM-Cache; der Poll holt ihn als erstes und vergleicht die sortierten Namen mit `discoveredUps` (`upsListChanged`).
26. **`onStateChange` — adapter-eigene Kanäle und Wert-Grenze (v0.11.0)** — `<usv>.info.*` (reachable, notify) und `<usv>.status.*` (geparste Flags) sind KEINE NUT-Variablen; ein Write dorthin (Skript, REST-API) endet mit debug, nicht als `SET VAR`, das upsd mit `VAR-NOT-SUPPORTED` und einer …
27. **Protokoll-Token-Wächter im Client (v0.11.0)** — `tokenError()` prüft jeden unquoted Wire-Parameter (USV-Name, Variablen-Name, Befehlsname) auf leer / Whitespace / `"` / `\`, bevor `LIST VAR/RW/CMD/ENUM/RANGE`, `GET VAR`, `SET VAR`, `INSTCMD`, `LOGIN` ihn senden.
28. **`ready` ≠ `connected` im Client (v0.11.0)** — `connected` steht ab TCP-Aufbau, `ready` erst nach vollständigem `connect()` (inkl.
29. **Bestätigungsbefehle verlangen `OK` (v0.12.0)** — `sendOk()` für `USERNAME`, `PASSWORD`, `LOGIN`, `LOGOUT`, `SET VAR`, `INSTCMD`, `STARTTLS`: gültig ist nur eine Zeile `OK` (auch `OK STARTTLS`, `OK TRACKING <id>`); jede andere Nicht-`ERR`-Zeile ist …
30. ⚠️ **ÜBERHOLT durch #33 (v0.13.0): das dauerhafte `LOGIN` auf der Betriebsverbindung ist wieder raus.** Historischer Stand v0.12.0/0.12.1 — **Mit Zugangsdaten meldet sich der Adapter IMMER an — EIN `LOGIN` je Verbindung (v0.12.0, krobi 2026-09-02: „dafür sind sie ja da")** — Reihenfolge in `onConnected`: `LIST UPS` → `USERNAME`/`PASSWORD` → `LOGIN <erste USV>`; danach werden ALLE USVs über dieselbe, nun geprüfte Verbindung gelesen und beschrieben (SET/INSTCMD prüfen Name+Passwort je Befehl, nicht `loginups`). Die Zugangsdaten gehören dem Server, nicht der USV — ein zweites `LOGIN` auf derselben Verbindung lehnt upsd ab (`ALREADY-LOGGED-IN`), das war der 0.4.5-Fehler „LOGIN je USV" und die falsche Konsequenz war, LOGIN ganz zu streichen. `authenticated` steht erst nach akzeptiertem LOGIN; ohne USV am Server: warn „nothing to log in to", keine Behauptung. **Voraussetzung im `upsd.users`: der Benutzer braucht `upsmon secondary` (oder `upsmon primary`)** — `actions = SET`/`instcmds` allein erlauben kein LOGIN; upsd antwortet bei falschem Passwort und bei fehlendem upsmon-Recht identisch `ACCESS-DENIED` (`user.c:306/311`), deshalb nennt `authFailureText()` beide Ursachen. Der Verbindungstest fährt exakt dieselbe Kette (+ `LOGOUT`) auf seiner Wegwerf-Verbindung und meldet erst dann „logged in as <user>" (Issue #17). Client-Zustand `loggedIn` (je Verbindung, Reset bei connect/close).
31. **Objekt ändern heißt zusammenführen, nie löschen — und der Adapter besitzt Name und Beschreibung (v0.12.0, Shelly-Vorbild, [[reference_iobroker_objekt_aendern_ohne_loeschen]])** — kein `preserve: common.name` mehr (weder am Gerät noch am Datenpunkt, auch nicht beim Anreichern): Name und Beschreibung gehören dem Adapter wie Typ und Rolle, eine Umbenennung im Objektbaum wird beim nächsten Abgleich …
32. **Zugangsdaten werden GEPRÜFT, aber nicht dauerhaft angemeldet (v0.13.0, krobis Entscheidung 2026-09-02 nach der Praxis-Recherche)** — die Betriebsverbindung sendet nur `USERNAME`/`PASSWORD` (die braucht der Schreibpfad); die PRÜFUNG läuft beim Start auf einer **kurzen zweiten Verbindung**, die nach `LOGIN` sofort zerstört wird (`verifyCredentials`; …
33. **Der Transport steht im Ergebnis (v0.12.0)** — Verbindungstest: „Connected via TLS, logged in as …" / „Connected unencrypted — …"; Startzeile: `(logged in as <user>|no credentials, TLS|unencrypted)`.
34. **Jeder Datenpunkt erklärt sich — `common.desc` als Übersetzungsobjekt (v0.13.0, Flottenstandard 2026-09-02)** — `tDesc(key)` aus `admin/i18n`, 269 Erklärungen in 11 Sprachen: Kanäle, adapter-eigene Datenpunkte, die 19 Statusflags (Schlüssel abgeleitet: `flagOnline` → `descFlagOnline`), 30 Befehle (`cmdBeeperMute` → …
35. **User-sichtbare WERTE folgen der Systemsprache (v0.13.0)** — `common.states` ist in ioBroker eine reine Zeichenketten-Abbildung, dort geht kein Übersetzungsobjekt: die Labels werden deshalb beim Schreiben über `tText()` (= `I18n.translate`, Systemsprache) aufgelöst.
36. **Aufräum-Runde des Vollaudits (v0.13.0)** — (a) `onUnload` verabschiedet sich IMMER mit `shutdown()`; die alte Bindung an „angemeldet" war seit Nr. 32 toter Code.

37. **Die Manifest-Objekte werden bei JEDEM Start neu angewandt (v0.14.0)** — `StateManager.refreshInstanceObjects()`, gerufen in `onReady` nach `I18n.init`. **Der Grund ist gemessen, nicht übernommen:** js-controller ruft beim Adapter-Start selbst `_createInstancesObjects` → `_extendObjects`, …
38. **Die CA-Datei wird nur gelesen, wenn sie gebraucht wird (v0.14.0)** — `loadTlsCa()` kehrt bei `tlsRejectUnauthorized = false` mit einer `debug`-Zeile zurück.
39. **`enrichStateMetadata` übersetzt die Wertelisten selbst (v0.14.0)** — die aus `LIST ENUM` gewonnenen Werte laufen dort durch `localizeStates`.
40. **Der Verbindungstest erzählt dieselbe Geschichte wie der Adapter (v0.14.0)** — abgelehnte Zugangsdaten sind seit Design #32 **kein** Fehlerfall: der Test antwortet mit `{ result: … }` („verbunden, aber Zugangsdaten abgelehnt — Lesen geht"), nicht mit `{ error: … }`. Ein Nicht-Auth-Fehler an …
41. **`dropCacheUnder` räumt ALLE Erinnerungen an eine USV (v0.14.0)** — nicht nur `createdIds`/`nutNames`, sondern auch `fallbackNames`, `pendingRecording` und die (jetzt je USV gekeyten) `warnedGarbageVars`.

42. **Der WERT weicht dem Typ des angelegten Datenpunkts (v0.15.0)** — `ensureState` schreibt das Objekt einmal pro Laufzeit (`createdIds`), und #16 verbietet ausdrücklich, den Typ zwischen zwei Polls umzuschreiben.
43. **Ein abwesender NUT-Server ist kein Fehler, sondern ein Zustand (v0.15.0)** — der Client wirft für „nicht verbunden"/„Verbindung geschlossen"/„Verbindungsaufbau überfällig" jetzt `NutConnectionError`, für ein Kommando-Zeitlimit `NutTimeoutError`; `classifyError` entscheidet an der **Klasse**, …
44. **`min`/`max` und eine Werteliste können wieder VERSCHWINDEN — aber nur, wenn wirklich etwas weggefallen ist (v0.15.0, umgebaut 2026-09-12)** — sie stammen allein aus `LIST RANGE`/`LIST ENUM` und dem eigenen Katalog.

45. **Punktlose Variablen: die Annahme war falsch, der Zweig widersprüchlich (v0.15.0)** — der Kommentar begründete ihn mit „a bare `ALARM` that some drivers expose".
46. **Zugangsdaten haben eine Grenze wie jedes andere Wire-Argument (v0.15.0)** — der Token-Wächter aus #27 deckte USV-, Variablen- und Befehlsnamen, aber ausgerechnet nicht `USERNAME`/`PASSWORD`.
47. **Eine Quelle für die Client-Optionen, ein Durchgang durch den Objektbaum (v0.15.0)** — `nutClientOptionsFrom(config)` in `coerce.ts` liefert die fünf konfigurationsabhängigen Felder für **alle drei** Clients (Betrieb, Zugangsdaten-Probe, Verbindungstest); der Router hatte eine eigene Kopie, also hätte …
48. **Das Objekt-Inventar ist die Datenpunkt-Prüfung ohne Server (v0.15.0)** — `npm run test:inventory` startet den Adapter im Wegwerf-js-controller gegen einen **Fake-`upsd` im Mocha-Prozess** (kein Werkzeug-Naht im Produktivcode, nichts verlässt die Maschine) und schreibt …

## NUT-Protokoll Referenz

- **Autoritative Quelle (Standard-Verifikation): NUT 2.8.5 Release-Quelle.** `docs/new-drivers.txt` = dokumentierte `status_set`-Werte; `docs/nut-names.txt` = Instant-Commands. Flag-/Command-Katalog treiber-agnostisch hiergegen verifiziert (NICHT gegen ein einzelnes Gerät). `grep -rhoE 'status_set\("[^"]+"' drivers/` für den realen Token-Satz
- Live-Sample zum Gegenprüfen: ein reales Eaton PRO 1600 (51 Variablen) — nur Test-Sample, NICHT als Standard-Referenz
- Port: 3493/TCP, ASCII-Zeilenprotokoll
- Auth: `USERNAME <user>` → `PASSWORD <pass>` → `LOGIN <ups>` (upsd prüft die Zugangsdaten ERST bei LOGIN/SET/INSTCMD/FSD — `server/netuser.c` speichert nur; `LOGIN` braucht `upsmon`-Recht im `upsd.users`; ein LOGIN je Verbindung)
- 23 Error-Codes in `types.ts:NUT_ERRORS`

## Design-Entscheidungen (Fortsetzung)

_Jede Entscheidung steht hier als Regel-Satz; Beleg, Messung und Verlauf stehen wörtlich in `.claude/dev-history.md`, Eintrag „2026-09-21 — Design-Entscheidungen: Belege aus CLAUDE.md verlegt“ (lokal, gitignored)._

49. **Die Variante behält ihr Kennzeichen — sonst heißen drei Phasen gleich (v0.15.0)** — `varTranslation` gab jeder Variante die Beschriftung ihrer Basisvariablen, ungekürzt: die drei `input.Lx.voltage` einer Drehstrom-USV hießen alle „Eingangsspannung", beide Umgebungssensoren „Umgebungstemperatur", alle …

50. **Zugangsdaten in der Test-Fixture müssen VERSCHLÜSSELT im Instanzobjekt liegen (v0.15.0)** — `username`/`password` stehen in `encryptedNative` (Wurzelebene von `io-package.json`, laut `@iobroker/types` genau dort richtig), also **entschlüsselt js-controller sie beim Start**.

51. **Eine Umbenennung nimmt die Raum-/Gewerkzuordnung mit (2026-09-12)** — die drei Stellen, die einen Datenpunkt umbenennen (`info.online`→`info.reachable`, `status.highEfficiency`→`status.ecoMode`, der v0.1.0-Punkt-Stil), tragen mit `carryUserSettings*` neben `common.custom` jetzt auch die …
52. **`ensureUpsDevice` schreibt nur bei geänderter Beschreibung (2026-09-12)** — `discover()` ruft es bei jedem (Wieder-)Verbinden; ungeschützt schrieb es den nackten USV-Namen über den mfr+model-Rückfall, und `updateDeviceName` übersprang die Reparatur danach, weil `fallbackNames` sie als erledigt …
53. **`poll()` weist nie ab — auch nicht aus dem eigenen `catch` (2026-09-12)** — die zwei Schreibvorgänge im `catch` (`info.connection`, `markAllUpsUnreachable`) waren die einzigen ungeschützten `await`s; mit toter States-DB (`ERROR_DB_CLOSED`) wies der Poll aus seinem eigenen Fehlerpfad ab, und …
54. **Ein fataler TLS-Fehler stoppt auch den Poll (2026-09-12)** — `onConnectFatal` zerstört den Client für immer; landet er auf einem **Reconnect** (CA-Datei verschoben, Zertifikat abgelaufen — `loadTlsCa()` läuft bei jedem Verbinden), war die Timer-Kette längst armiert und lief ewig …
55. **Ein Schreibvorgang auf einen read-only Datenpunkt erreicht die Leitung nicht (2026-09-12)** — `writableVars` hält je USV, was `LIST RW` beim letzten Poll listete; `onStateChange` lehnt alles andere auf `debug` ab statt ein `SET VAR` zu schicken, das upsd mit `READONLY` und einer roten Zeile quittiert.
56. **Drei Härtungen ohne eigene Geschichte (2026-09-12)** — (a) `enrichWritableVars` trennt Protokollaufruf und Objekt-Schreibvorgang in zwei `try`s; vorher hieß jeder gescheiterte Schreibvorgang „LIST ENUM/RANGE … not supported" auf debug, jetzt `warn` mit Datenpunkt …
57. **Der Start-Test gegen den Fake-`upsd` läuft in der CI bei jedem Push (2026-09-15, Flotten-Gate-Job `adapter-inventory`)** — bis dahin fuhr GitHub nur die nackte Startprobe (`test/integration.js`), und Dependabot mergte bei Grün; `npm run test:inventory` lief allein im Release-Vorlauf (D06).

## Tests (720 unit = 702 Adapter + 18 Repo-Standards aus `iobroker-adapter-checks`; + 58 package = 778) + `npm run test:inventory` (Objekt-Inventar, 643 Objekte; Aufstiegs-Suite mit Raum-Zuordnung)

## Versionshistorie

Aktuelle Version: `io-package.json`. **User-facing Changelog:** `README.md` + `io-package.json:common.news` (11 Sprachen, handgeschrieben). **Interne Entwicklungs-Historie** (Findings, Root-Causes, verworfene Wege): `.claude/dev-history.md` — lokal, nicht git-getrackt, bewusst aus dieser Datei ausgelagert um sie schlank zu halten.

## Befehle

```bash
npm run build         # Production (esbuild)
npm test              # vitest src/**/*.test.ts + @iobroker/testing packageFiles (mocha)
npm run coverage      # vitest run --coverage
npm run lint          # ESLint
npm run format:check  # Prettier --check
npm run check         # tsc --noEmit (Type-Check)
```

**Ausschlüsse in den beiden format-Skripten — die Flotten-Fassung, seit 2026-09-14 per Konsistenz-Autofix
gesetzt** (Regel in `Entwicklung/CLAUDE_PACKAGES.md`, Abschnitt prettier): ausgeschlossen wird, was IM REPO
liegt und eine FREMDE Formatierungsautorität hat — (1) ein Werkzeug schreibt sie (`build/`, `io-package.json`

- `README.md` durch das Release-Skript, `CHANGELOG_OLD.md`, `package-lock.json`, `test/objects.inventory.json`,
  `.github/dependabot.yml`, …), (2) der Konsistenz-Master ist die Autorität (`tsconfig*.json`,
  `.releaseconfig.json`, `.vscode/**`, die master-verglichenen `.github`-Dateien). Alles andere wird geprüft,
  auch `docs/` und diese Datei. **Nie** eine `.prettierignore` (Prüfbot W0084/W5048). ⚠️ **„Wird oft neu
  geschrieben" ist KEIN Ausschlussgrund** (krobi 2026-09-07) — `.remember/` (Zustandsdateien des
  Remember-Plugins) steht deshalb nicht im Skript, sondern strukturell in der Wurzel-`.gitignore` (prettier
  liest sie als Ignore-Quelle) und als `.remember/**` in den `ignores` der `eslint.config.mjs` (ESLint liest die
  `.gitignore` NICHT; der Abkühl-Marker `tmp/last-ndc.ts` ist kein TypeScript) — beides Flotten-Gates mit
  Autofix (`audit_remember_gitignore`, `audit_remember_eslint_ignore`).
