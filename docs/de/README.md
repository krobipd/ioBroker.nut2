# ioBroker.nut2 — Einrichtung

Dieser Adapter liest unterbrechungsfreie Stromversorgungen über einen **NUT-Server** (Network UPS Tools). Er spricht
nie direkt mit der USV: Die USB- oder Netzwerkverbindung zur Hardware gehört dem NUT-Server, der Adapter ist einer
seiner Clients. Deshalb beginnt jede Einrichtung auf dem Rechner, an dem die USV hängt.

Die README ist die Kurzfassung. Diese Seite geht eine vollständige Einrichtung durch.

## 1. Sicherstellen, dass ein NUT-Server läuft

Es braucht einen Rechner, auf dem `upsd` läuft und mindestens eine USV eingerichtet ist — ein Linux-Host, ein NAS
(Synology, QNAP und UGREEN bringen NUT mit) oder ein Raspberry Pi mit der USV am USB.

Auf diesem Rechner prüfen:

```bash
upsc -l                 # listet die USV-Namen, z. B. "ups0"
upsc ups0               # zeigt alle Werte dieser USV
```

Gibt `upsc -l` nichts aus, liegt das Problem auf der NUT-Seite und der Adapter kann nicht helfen — zuerst den Treiber
in Ordnung bringen (`/etc/nut/ups.conf`, danach `upsdrvctl start`).

## 2. Den Server für den Adapter erreichbar machen

`upsd` lauscht nur auf localhost, solange man ihm nichts anderes sagt. In `/etc/nut/upsd.conf`:

```
LISTEN 0.0.0.0 3493
```

Danach `upsd` neu starten. Port `3493/TCP` muss zwischen ioBroker-Host und NUT-Server offen sein.

Viele NAS-Systeme betreiben NUT in einem „USV-Server"-Modus mit einer eigenen Freigabeliste in der Weboberfläche — die
IP-Adresse des ioBroker-Hosts muss dort eingetragen sein.

## 3. Einen Benutzer anlegen (optional, aber empfohlen)

Zum Lesen der Werte braucht es überhaupt keine Anmeldung. Ein Benutzer wird nur für zwei Dinge gebraucht: die USV
schalten (Befehle) und Variablen schreiben. Eintrag in `/etc/nut/upsd.users`:

```
[iobroker]
    password = etwas-langes-waehlen
    upsmon secondary
    actions = SET
    instcmds = ALL
```

Zwei Zeilen mit verschiedenen Aufgaben:

- `upsmon secondary` ist das, was eine **Anmeldung** überhaupt möglich macht. Der Adapter meldet sich einmal beim Start
  an, auf einer kurzen zweiten Verbindung, ausschließlich um Ihnen zu sagen, ob die Zugangsdaten funktionieren. Ohne
  diese Zeile wird die Anmeldung abgelehnt — siehe die häufigen Fragen, das ist kein Fehler.
- `actions` und `instcmds` entscheiden, was der Benutzer tatsächlich **tun** darf. `upsd` prüft sie je Befehl,
  unabhängig von der Anmeldung.

Nach dem Bearbeiten `upsd` neu starten.

## 4. Instanz in ioBroker anlegen

Adapter installieren, Instanz anlegen, Reiter **Verbindung** ausfüllen:

| Einstellung           | Was hineingehört                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| NUT-Server-Adresse    | Hostname oder IP des Rechners, auf dem `upsd` läuft                                                       |
| Port                  | `3493`, sofern nicht geändert                                                                             |
| Netzwerkschnittstelle | Auf „alle" lassen, außer der ioBroker-Host hängt in mehreren Netzen und nur eines erreicht den NUT-Server |
| Abfrageintervall      | `15` Sekunden sind ein guter Ausgangswert — siehe unten                                                   |
| Benutzer / Passwort   | Der Benutzer aus Schritt 3, oder leer lassen für reine Überwachung                                        |

**Verbindung testen** drücken. Die Antwort benennt, was wirklich geprüft wurde: ob die Verbindung verschlüsselt ist,
wie viele USVen der Server anbietet und — wenn Zugangsdaten eingetragen sind — ob die Anmeldung akzeptiert wurde.

Danach speichern. Der Adapter verbindet sich, erkennt jede USV am Server und legt die Datenpunkte an.

### Wie oft sollte abgefragt werden?

Schneller als der NUT-Treiber seine Daten auffrischt, bringt nichts. In `/etc/nut/ups.conf` hat der Treiber zwei
Einstellungen: `pollinterval` (wie oft der Status aufgefrischt wird, Vorgabe 2 s) und `pollfreq` (der ganze Wertesatz,
Vorgabe 30 s bei USB-Treibern). Alle 15 Sekunden ist ein sinnvoller Mittelweg; unter 2 Sekunden liest der Adapter nur
noch Werte erneut, die sich nicht geändert haben.

Wer von einem Stromausfall _im Moment des Geschehens_ erfahren will statt beim nächsten Abruf, senkt nicht das
Intervall, sondern nutzt die Ereignis-Klingel aus den häufigen Fragen.

## 5. Die Verbindung verschlüsseln (optional)

Ohne TLS gehen Benutzername und Passwort im Klartext über das Netz. Wenn das in Ihrer Umgebung zählt: `upsd` kann mit
TLS-Unterstützung gebaut werden und bietet dann **STARTTLS**:

1. Am Server `CERTFILE` (oder `CERTPATH`) in der `upsd.conf` einrichten.
2. Im Adapter **TLS verwenden (STARTTLS)** anhaken.

In der Voreinstellung prüft der Adapter das Zertifikat nicht — das verschlüsselt gegen Mitlesen, erkennt aber keinen
Mann-in-der-Mitte, weil fast jeder NUT-Server ein selbstsigniertes Zertifikat verwendet.

Für echten Schutz zusätzlich **Gültiges Zertifikat verlangen** anhaken und bei **CA-Zertifikatsdatei** eine PEM-Datei
auf dem ioBroker-Host angeben, gegen die geprüft werden kann — die eigene Zertifizierungsstelle oder das
selbstsignierte Serverzertifikat selbst. Die Datei wird nur gelesen, solange die strenge Prüfung an ist; ein Pfad, der
von einem früheren Versuch übrig geblieben ist, schadet nicht.

Wurde der NUT-Server ohne TLS gebaut, sagt der Verbindungstest das, statt still auf Klartext zurückzufallen.

## 6. Die USV aus ioBroker schalten (optional)

Zwei Schalter im Reiter **Erweitert** öffnen die Schreibrichtung, beide sind bewusst aus:

- **Befehle aktivieren** legt je Befehl, den die USV anbietet, eine Taste an (Signalton, Selbsttest, Last abschalten …).
  Der Kanal `commands` erscheint erst, wenn das an ist **und** Zugangsdaten hinterlegt sind — `upsd` prüft
  Befehlsrechte gegen einen benannten Benutzer. Sein Text-Datenpunkt `commands.execute` führt einen Befehl mit Wert
  aus, etwa `load.off.delay 120`.
- **SET VAR aktivieren** macht die USV-Variablen, die der Server als schreibbar meldet, auch in ioBroker schreibbar.

Beides braucht die passenden Rechte in der `upsd.users` (Schritt 3). Mit den Last-Befehlen vorsichtig umgehen:
`load.off` nimmt allem den Strom, was an der USV hängt.

## Wie es weitergeht

- [Datenpunkte](datapoints.md) — was der Adapter anlegt und was die einzelnen Teile bedeuten.
- [Häufige Fragen](faq.md) — unter anderem sofortige Ereignis-Meldungen über `upsmon`.
