# Red Team und Nachverfolgbarkeit

**Stand:** 11.10.2026. Angriffe aus Auftrag §12 («Exploratives Red Team vor P1-Abnahme»), jeweils mit dem Test, der
sie reproduzierbar prüft. Alle Tests laufen gegen den lokalen Supabase-Stack mit echten RLS-Regeln.

| Angriff | Versuch | Test | Ergebnis |
|---|---|---|---|
| Falsche Forderung | Mitglied setzt fremden Zahler / schreibt ihn beim Ändern um | `security.test.ts` SEC-04/05 | abgelehnt |
| Falsche Forderung | Rückzahlung von Nicht-Empfänger (auch Admin) bestätigt, an Platzhalter oder sich selbst | `security.test.ts` SEC-10/11 | abgelehnt |
| Falsche Forderung | «Erwin hat bezahlt» per Schnellerfassung oder WhatsApp | `parse.test.ts`, `whatsapp.test.ts` WA1-7/8 | nie gebucht |
| Cross-Trip | Nicht-Mitglied liest alle Tabellen, manipulierte `trip_id`, Realtime-Abo | `security.test.ts` SEC-01/02, `storage-realtime.test.ts` | nichts sichtbar |
| Cross-Trip | direkte Tabellen-Schreibzugriffe, anon-RPCs | `security.test.ts` SEC-01/16 | gesperrt |
| Fremde Claims | weitergeleiteter Einladungslink zu bebuchtem Platzhalter | `security.test.ts` SEC-06/07, `whatsapp.test.ts` WA1-3 | kein Zugriff bis Admin-Freigabe |
| Fremde Claims | verlorene Gastsitzung, gleicher Name, gleicher Link | `guest.test.ts` SEC-08 | kein Zugriff |
| Fremde Claims | Mitglied macht sich selbst zur Reiseleitung | `guest.test.ts` R11 | nur Betreiber per SQL, auditiert |
| Race Conditions | 5× gleicher Idempotenz-Schlüssel parallel, doppelte Bestätigung, parallele Admin-Übergabe, 3× gleiche WhatsApp-Nachricht parallel | `ledger.test.ts`, `security.test.ts` SEC-14, `whatsapp.test.ts` WA1-6 | genau eine Wirkung |
| Foto-Leak | Fremder lädt, listet, signiert, lädt hoch oder löscht | `storage-realtime.test.ts` SEC-09 | abgelehnt |
| Foto-Leak | GPS/EXIF im Foto | `receipts-offline.spec.ts` | entfernt |
| Foto-Leak | Fotos nach Reiselöschung | `trip-deletion.test.ts` | gelöscht, andere Reisen intakt |
| CSV-Angriff | Formel-Injection in Titel/Namen/Notiz (inkl. Vollbreite, Steuerzeichen) | `csv.test.ts`, `npm run test:csv-office` (LibreOffice) | keine Formel |
| CSV-Angriff | dieselbe Datei zweimal, fehlerhafte Zeile, fremde Reise, erzwungene Herkunft | `csv-import.test.ts` | abgelehnt, atomar |
| Restore-Scheitern | falscher Host, nicht leeres Ziel; Prüfsummen jeder Datei | `scripts/backup/probe.mjs` (19 Prüfungen) | Restore verweigert bzw. identisch |
| WhatsApp | gefälschte Signatur, Replay, fremde Nummer, gesperrte Verbindung | `whatsapp.test.ts` (18 Fälle) | keine Ausgabe |

## Gefundene und behobene Fehler (reproduzierbar)

| Fund | Wie gefunden | Behebung |
|---|---|---|
| Reiselöschung scheiterte an Fremdschlüssel `expense_splits → trip_people` | `trip-deletion.test.ts` | Kindtabellen in fester Reihenfolge löschen |
| Neue private Tabellen ohne RLS | Katalogprüfung SEC-16 | RLS aktiviert, Rechte entzogen |
| Titel `'=abc` überstand CSV Export → Import nicht unverändert | Property-Test `csv.test.ts` | Neutralisierung exakt umkehrbar |
| Eingabefelder für Beträge/Prozente pro Person ohne übersetzte Beschriftung (Screenreader las den Schlüssel) | E2E Schnellerfassung | Texte ergänzt, i18n-Test erkennt jetzt auch `t(a ? 'x' : 'y')` |
| Restore brach ab, weil eine Migration die WhatsApp-Konfigurationszeile anlegt | Backup-Probe | Restore ersetzt die Zeile durch die gesicherte |
| Geteilter Text ging beim Umweg über die Anmeldung verloren | Code-Review | Rücksprung behält die Query |
| Zahler-Formulierungen im Text hätten als eigene Zahlung gebucht | WA1-7 | Parser lehnt sie ab (`payer_in_text`) |

Offen ist kein bekannter Sicherheitsfund.
