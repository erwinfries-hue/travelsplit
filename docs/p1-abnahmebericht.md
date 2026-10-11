# P1-Abnahmebericht TravelSplit

Stand: 2026-10-11 · Branch `p0-core` · PR #1 (Entwurf)

## Ergebnis

Der private MVP ist **lokal vollständig gebaut und geprüft**. Für den echten Einsatz fehlen nur Schritte, die Konten
von Erwin brauchen: Hosting, Google-Login und Tests auf echten Handys.

**Empfehlung: «Privater Praxiseinsatz noch nicht möglich», aus zwei Gründen:**
1. Die App ist noch nicht veröffentlicht. Das braucht die Gratis-Konten Supabase, Cloudflare und Google; ich lege sie gemäss Auftrag nicht selbst an.
2. UX-01/02 (Galaxy S25, iPhone) sind erst im Handy-Emulator geprüft, nicht auf echten Geräten.

Fachlich und sicherheitstechnisch ist kein Pflicht-Gate offen. Sind die Konten eingerichtet ([Anleitung](installation-und-betrieb.md))
und die beiden Handy-Tests gemacht, lautet die Empfehlung «möglich».

| Prüfung | Ergebnis |
|---|---|
| Lint (oxlint), Typecheck (TS strict) | grün |
| Unit-Tests (Geldlogik, CSV, Bilder, Parser, i18n) | 81/81 |
| Integrations- und Angriffstests gegen lokales Supabase | 66/66 (davon 18 WhatsApp) |
| Klicktests Handy-Viewport (Playwright, Pixel 7, de-CH) | 12/12 |
| CSV-Formel-Schutz mit echtem LibreOffice | 3/3 |
| Backup/Restore-Probe in isoliertem zweitem Stack | 19/19 |
| Build und Secret-Scan des Bundles (SEC-15) | grün |
| GitHub-CI | **nie gelaufen**: GitHub startet keine Jobs («recent account payments have failed or your spending limit needs to be increased»). Liegt am GitHub-Konto, nicht am Code. |

## P1-Umfang (Auftrag §13) und Stand

| Punkt | Stand | Nachweis |
|---|---|---|
| Mobile Details, Ausgabendetail mit Verlauf | ✓ | E2E `smoke`, Screenshots |
| Persönlich widerrufbare Einladungen | ✓ | SEC-06/07 |
| Gastzugang und Upgrade auf Google | ✓ | `guest.test.ts` SEC-08, R6 |
| Komprimierte Belegfotos ohne EXIF/GPS, privat | ✓ | `receipts-offline.spec.ts`, SEC-09 |
| Offline-Entwürfe, bewusst gesendet, nie doppelt | ✓ | `receipts-offline.spec.ts` |
| In-App-Hinweise | ✓ | Mitteilungen im Profil |
| DE/EN komplett | ✓ | `i18n.test.ts` (Schlüsselgleichheit, alle Fehlercodes, Verlauf, Mitteilungen) |
| CSV-Export/-Import mit Vorschau, atomar, nur einmal | ✓ | `csv-import.test.ts`, `csv.spec.ts`, [Schema](csv-schema-v1.md) |
| PDF-Abrechnung | ✓ | Druckansicht mit Serverabgleich, [Beispiel](examples/abrechnung-beispiel.pdf) |
| Gruppenausgleichsvorschläge | ✓ | Salden, Cockpit |
| Archiv mit Warnung und Snapshot | ✓ | OPS-02 |
| Reiselöschung inkl. Fotos | ✓ | OPS-03, `delete.spec.ts` |
| Admin-Übergabe und Recovery | ✓ | SEC-14, R11, [Runbook](betreiber-runbook.md) |
| Abschliessende Backup-/Restore-Probe | ✓ | 19/19 nach allen Schemaänderungen |
| Runbook, Handbücher DE/EN | ✓ | [Runbook](betreiber-runbook.md), [Handbuch](handbuch.md), [Handbook](handbook.md) |
| Kostenloses Hosting | ⏳ vorbereitet | [Anleitung](installation-und-betrieb.md), `public/_headers`; braucht Erwins Konten |
| Galaxy-/iOS-Onboarding | ⏳ beschrieben | Installationsschritte in der Anleitung; Test auf echten Geräten offen |
| Red Team | ✓ | [red-team-traceability.md](red-team-traceability.md), kein offener Fund |

## Neu seit dem P0-Bericht

**Schnellerfassung und Teilen (WA-Ersatz, kostenlos):**
- `src/domain/ingest/parse.ts`: regelbasierter Parser (WA-BOOK §6). Mehrdeutige Beträge, fehlende Währung, doppelte Namen und Zahler-Formulierungen werden abgewiesen.
- `src/domain/ingest/resolve.ts`: Namen der Reise zuordnen; Unbekanntes oder Mehrdeutiges wird gemeldet, nie geraten.
- `src/features/quick/`: Schnellerfassung im Cockpit, Android-Teilen-Ziel (`/share`, Manifest `share_target`), Prüffall-Liste.
- Das normale Formular wird nur vorausgefüllt; gespeichert wird erst nach Prüfung.
- Reisecode in den Einstellungen (`#LIS26 …` wählt die Reise).

**WhatsApp-Adapter, vorbereitet und ausgeschaltet:**
- Migration `20261011220000_whatsapp_adapter.sql`.
- Webhook `supabase/functions/whatsapp-webhook/` (nicht deployt).
- Ein Buchungsdienst für App, CSV und WhatsApp: `private.create_expense_as`.
- Tests WA1-1 bis 12 grün mit synthetischen Nachrichten.
- Dokumente: [WA0](wa0-eligibility-cost-check.md) (rot), [Blocker](wa-blockers.md), [WA1-Tests](wa1-security-test-results.md), [WA2-Checkliste](wa2-activation-checklist.md).

**Weiteres:**
- CSV hat die zusätzliche letzte Spalte `source`; ältere Dateien bleiben gültig.
- Das PDF markiert WhatsApp- und CSV-Ausgaben.
- Restore ersetzt die durch Migrationen angelegte Konfigurationszeile.

## Datenbank

9 Migrationen. Neu in P1:
- `…200000_csv_import`
- `…210000_trip_deletion`
- `…220000_whatsapp_adapter`

## Risikoregister

| Risiko | Wirkung | Massnahme |
|---|---|---|
| Supabase Free pausiert nach 7 Tagen ohne Nutzung | App zwischen Reisen nicht erreichbar | im Dashboard reaktivieren; Ausgaben bleiben solange Entwurf |
| Keine automatischen Backups im Free-Plan | Datenverlust | `scripts/backup/backup.sh` vor jeder Pause und jedem Update ([Anleitung](backup-restore.md)) |
| Verlorener Gastzugang | Gast kommt nicht mehr in die Reise | neuer Link durch die Reiseleitung; Google-Upgrade empfohlen |
| iPhone: kein Teilen-Ziel, Google-Login öffnet evtl. Safari | etwas umständlicher | Text kopieren und einfügen; auf echtem Gerät prüfen |
| Anbieter ändern Gratis-Limits | Kosten oder Sperre | monatlich Usage ansehen; kein Bezahlplan aktivieren |
| GitHub-Actions gesperrt | keine automatischen Tests auf GitHub | Billing im GitHub-Konto klären; bis dahin lokal geprüft |
| WhatsApp-Bot | nicht zulässig (WA0) | `WHATSAPP_MODE=off`, Ersatz per Schnellerfassung |

## Was Erwin als Nächstes tun kann

1. GitHub → Settings → Billing and plans: Zahlungsproblem beheben, damit die CI läuft.
2. Konten anlegen und die App veröffentlichen, nach [installation-und-betrieb.md](installation-und-betrieb.md).
3. Mit zwei Testpersonen auf Galaxy und iPhone eine Probereise machen.
