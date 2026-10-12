# P0-Abnahmebericht TravelSplit

Stand: 2026-10-11 · Branch `p0-core` · PR #1

## Ergebnis

Der P0-Kern läuft lokal vollständig und alle automatischen Prüfungen sind grün:

| Prüfung | Ergebnis |
|---|---|
| Lint (oxlint), Typecheck (TS strict) | grün |
| Unit-Tests Geldlogik | 27/27 |
| Integrations- und Angriffstests gegen lokales Supabase | 36/36 |
| Klicktest Handy-Viewport (Playwright, Pixel 7) | 3/3 |
| Build + Secret-Scan des Bundles (SEC-15) | grün |
| Backup/Restore-Probe R4 in isolierten zweiten Stack | 19/19 |

**GitHub-CI ist noch nie gelaufen.** GitHub startet den Job nicht mit der Meldung «recent account payments have
failed or your spending limit needs to be increased». Das betrifft das GitHub-Konto, nicht den Code. Bis das
geklärt ist, wurden alle CI-Schritte lokal in identischer Reihenfolge ausgeführt (Ergebnis oben).

## Was gebaut ist

### Datenbank (6 Migrationen in `supabase/migrations/`)

| Migration | Inhalt |
|---|---|
| `…184226_money_functions` | Währungstabelle, Umrechnung `convert_minor`, grösste-Reste-Verteilung (identisch zum TypeScript-Code) |
| `…184300_core_schema` | 17 Tabellen, RLS (nur Lesen für bestätigte Mitglieder), Schutz-Trigger: Audit nur anhängen, bestätigte Zahlungen eingefroren, Abschlüsse unveränderlich |
| `…184400_internal_helpers` | Berechtigungsprüfungen, Audit, Mitteilungen, Saldenberechnung |
| `…184500_rpc` | alle Schreibwege als geprüfte Server-Funktionen: Reise, Personen, Kurse, Ausgaben, Rückzahlungen, Einladungen, Claims, Admin-Übergabe, Abschluss; Betreiberfunktionen ohne API-Zugriff |
| `…184600_storage_realtime` | privater Bucket `receipts` (max. 1 MB, JPEG/WebP), Rechte über Datenbank statt Pfad, Realtime nur als Aktualisierungssignal |
| `…184700_grants_hardening` | entzieht allen Funktionen die Standardrechte; Gäste ohne Login dürfen nichts |

### App (`src/`, 41 Dateien)

Login (Google, lokal Test-Login), Einladung annehmen (Google oder Gast mit Verlustwarnung), Reiseliste,
Reise-Cockpit, Ausgabe erfassen/bearbeiten/löschen mit Live-Vorschau der Anteile, Ausgabendetail mit Verlauf,
Salden mit Ausgleichsvorschlägen, Rückzahlung melden/bestätigen/ablehnen/zurückziehen/stornieren, Personen und
Einladungslinks, Kursblatt mit Auswirkungsvorschau, Einstellungen (Admin-Übergabe, Abschluss, Wiederöffnen),
Profil mit Mitteilungen und Sprache DE/EN. PWA-Manifest und Icons aus dem Logo, Update-Hinweis bei neuer Version.

### Werkzeuge

- `scripts/dev-seed.mjs`: Testnutzer Erwin/Larissa/Roger und Demoreise, nur gegen lokalen Stack
- `scripts/backup/`: `backup.sh`, `restore.sh`, `storage.mjs`, `manifest.mjs`, `probe.mjs` (siehe [backup-restore.md](backup-restore.md))
- `scripts/check-bundle-secrets.mjs`: SEC-15

## Nachweis je Anforderung

| ID | Anforderung | Nachweis |
|---|---|---|
| R1 | Kurs je Reise, bestätigte Zahlung friert Kurs ein | `ledger.test.ts` SEC-12; Probe «confirmed settlement snapshot identical» |
| R2 | Normalnutzer zahlt nur selbst, Admin-Rekonstruktion markiert | `security.test.ts` SEC-04/05 |
| R3 | Claim auf bebuchten Platzhalter nur mit Admin-Freigabe | `security.test.ts` SEC-06/07 |
| R4 | Backup und echter Restore mit Fotos und Rollen | Probe 19/19 (unten) |
| R5 | Ganzzahlige Geldlogik, exakte Anteile | `money.vectors`, `money.property`, `money-parity` (1 500 Zufallsfälle TS = SQL) |
| SEC-01/02 | Kein Zugriff fremder Nutzer, keine `trip_id`-Manipulation | `security.test.ts` |
| SEC-03 | Reise erstellen nur mit Google + Freigabe | `security.test.ts` |
| SEC-08 | Gast verliert Sitzung | Warnung beim Beitritt und im Profil vorhanden; Gast-Upgrade folgt in M5 |
| SEC-09 | Fremder lädt Beleg | `storage-realtime.test.ts` |
| SEC-10/11 | Fremde/doppelte Bestätigung | `security.test.ts`, `ledger.test.ts` |
| SEC-13 | Archivierte Reise unveränderbar | `ledger.test.ts` |
| SEC-14 | Parallele Admin-Übergabe | `security.test.ts` |
| SEC-15 | Keine Secrets im Bundle | `check:bundle-secrets` |
| SEC-16 | Keine Tabelle/Funktion ohne Schutz | `security.test.ts` Katalogprüfung |
| DATA-01/02 | Salden summieren 0, Anteile exakt | Unit- und Property-Tests |
| DATA-03 | Doppeltap/Retry | `ledger.test.ts` (5× parallel → 1 Ausgabe) |
| DATA-05 | Storno bestätigter Zahlung | `ledger.test.ts` |
| DATA-06 | Restore identisch und geschützt | Probe |
| OPS-02 | Abschluss mit Restschuld | `ledger.test.ts` |

## M4 Backup-Restore-Probe (R4)

Quelle: lokaler Stack. Ziel: zweiter, getrennter lokaler Stack (eigene Ports, eigenes Projekt). Szenario:
Erwin, Larissa und Roger; Ausgaben in EUR, CHF und USD; Kurs CHF von 1,07 auf 1,05 geändert; Roger zahlt
CHF 50 an Erwin, Erwin bestätigt; zwei Belegfotos; Reise mit Restschuld abgeschlossen.

| Prüfung | Ergebnis |
|---|---|
| Archiv ist verschlüsselt (keine Klartext-E-Mail in der Datei) | ✓ |
| Restore verweigert falsches Zielprojekt | ✓ |
| Restore verweigert nicht leeres Ziel | ✓ |
| Alle drei melden sich im neuen Projekt mit den alten Zugangsdaten an | ✓ |
| Salden aus Sicht von Erwin, Larissa und Roger identisch | ✓ ✓ ✓ |
| Bestätigte Zahlung mit eingefrorenem Kurs identisch | ✓ |
| Kurse und Kursversionen identisch | ✓ |
| Abschluss-Snapshot und SHA-256 identisch, Hash auf dem Ziel neu berechnet | ✓ ✓ |
| Audit-Spur vollständig (20 Einträge) | ✓ |
| Beide Fotos mit identischem SHA-256 | ✓ |
| 4. Nutzer: keine Reisen, keine Salden, keine Ausgaben, kein Foto, kein Beitritt per offenem Link | ✓ ✓ ✓ ✓ ✓ |

## Bewusst noch nicht in P0 (folgt laut Plan in P1)

- M5: Gast → Google-Upgrade, Betreiber-Recovery-Runbook
- M6: Fotoaufnahme in der App (Kompression, EXIF entfernen), Offline-Entwürfe. Die Server-Seite für Fotos ist fertig und getestet.
- M7: CSV-Export/-Import (DATA-04), PDF
- M8: vollständige Reiselöschung (OPS-03)
- M9: Feinschliff, A11y, Installationshilfe; UX-01/02 auf echten Geräten
- WA1-light mit synthetischen Daten, Schnellerfassung per Text und Android-Teilen

## Was Erwin vor einem echten Einsatz entscheiden muss

1. **GitHub-Abrechnung:** CI startet erst, wenn GitHub die Actions-Sperre aufhebt (Zahlungsmethode oder Limit im
   GitHub-Konto). Ich ändere dort nichts.
2. **Hosting und Google-Login:** Für eine echte Nutzung braucht es ein Supabase-Projekt (Free), ein
   Cloudflare-Pages-Projekt (Free) und einen Google-OAuth-Client. Das sind Konten bzw. Registrierungen, die ich
   gemäss Auftrag nicht selbst anlege. Bis dahin läuft alles lokal.
