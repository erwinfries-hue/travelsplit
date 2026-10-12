# WA1: Sicherheitstests des WhatsApp-Adapters

**Stand:** 11.10.2026 · **Ergebnis:** 19/19 grün · nur synthetische, lokal signierte Nachrichten, kein Meta-Zugang

Ausführen: `npx supabase start`, dann `npx vitest run --project integration tests/integration/whatsapp.test.ts`.
Die Tests rufen den echten Webhook-Code (`supabase/functions/whatsapp-webhook/handler.ts`) mit einem Request auf und
lassen ihn über die Service-Rolle in die lokale Datenbank schreiben. Für die Dauer der Tests steht der Datenbankmodus
auf `sandbox`, danach wieder auf `off`.

| Fall (Spez. §8) | Was geprüft wird | Ergebnis |
|---|---|---|
| WA1-1 | Signatur fehlt, falsch, anderer Schlüssel, Gross-/Kleinschreibung, Body nach dem Signieren verändert → 401, kein Eintrag | ✓ |
| WA1-1 | GET-Challenge nur mit richtigem Verify-Token und `hub.mode=subscribe`; Modus off → 404 für GET und POST | ✓ |
| WA1-1 | Datenbankmodus off → nichts gespeichert; App-Nutzer können `whatsapp_ingest` nicht aufrufen | ✓ |
| WA1-1 | fremde `phone_number_id`, reine Status-Updates, Bilder, kaputtes JSON, falsches `object` → keine Ausgabe | ✓ |
| WA1-2 | unbekannter Absender, falscher, ersetzter, abgelaufener und zweimal benutzter Code → keine Ausgabe; Nummer nur als HMAC-Hash und maskiert gespeichert | ✓ |
| WA1-2 | eine verbundene Nummer kann keine zweite Person übernehmen; Codes nur durch Reiseleitung, nur für beigetretene Personen | ✓ |
| WA1-3 | Platzhalter mit alten Buchungen: vor der Admin-Freigabe des Beitritts kein Code; danach bucht die richtige Person | ✓ |
| WA1-4 | `Taxi 100 GEL alle` mit Kurs 0,34 → eine Ausgabe 100 GEL, Zahler = Absender, 50/50, Saldo ±17,00 EUR, Audit mit Empfängerliste | ✓ |
| WA1-4 | Namen (ohne Gross-/Kleinschreibung) und Prozente | ✓ |
| WA1-5 | zwei Reisen ohne Code → nur Reisewahl offen, Salden unverändert, Prüffall nur für den Absender sichtbar; mit `#CODE` genau eine Reise; fremder Code → keine Buchung | ✓ |
| WA1-6 | dieselbe `wamid` doppelt, in neuer Zustellung und dreimal gleichzeitig → genau eine Ausgabe | ✓ |
| WA1-7 | `10/100`, `100 oder 150`, fehlende oder unbekannte Währung, doppelte und unbekannte Namen, keine Teilnehmenden, Prozentsumme ≠ 100, Betrag 0, fehlender Kurs, «hat bezahlt» / «paid by» → Prüffall, kein Saldo | ✓ |
| WA1-8 | nur vier WhatsApp-Funktionen für die Service-Rolle; Zahler immer die eigene Person; auch ein gefälschter Aufruf des Buchungsdienstes kann keinen fremden Zahler setzen | ✓ |
| WA1-9 | gesperrte Verbindung, Wiederverbinden derselben gesperrten Nummer, entfernte Person, archivierte Reise → keine Ausgabe | ✓ |
| WA1-10 | Kursänderung bewertet WhatsApp-Ausgaben neu, bestätigte Rückzahlung bleibt eingefroren | ✓ |
| WA1-11 | WhatsApp-Ausgabe bleibt nach dem Abschalten sichtbar und in der App änderbar; CSV-Spalte `source`, Hinweis im PDF | ✓ |
| WA1-12 | der Webhook macht keinen einzigen Netzwerkaufruf; `outbound_enabled = true` scheitert am Constraint; Limit pro Absender greift fail-closed; Telefonnummer verlässt den Webhook nie im Klartext | ✓ |
| Zusatz | Prüffall erledigen oder verwerfen löscht den gespeicherten Text | ✓ |
| Zusatz | Nachrichtentexte älter als 30 Tage werden auch bei ausgeschaltetem Modus gelöscht; Betreiberfunktion zum Aufräumen | ✓ |

## Weitere Schutzmassnahmen im Code

- Signaturprüfung vor jedem JSON-Parsing, Vergleich in konstanter Zeit, Body höchstens 64 KB.
- Strenges Schema: nur `whatsapp_business_account`, nur Feld `messages`, Formate von `from`, `id`, `timestamp` geprüft, Text höchstens 1000 Zeichen.
- Idempotenz doppelt: eindeutige `provider_message_id` und eine aus der `wamid` abgeleitete Idempotenz-ID der Ausgabe.
- Schlägt eine Serverregel fehl (z. B. fehlender Kurs), entsteht ein Prüffall statt eines Fehlers. Bei Datenbankausfall antwortet der Webhook 500, Meta wiederholt, und es bleibt bei höchstens einer Ausgabe.
- Nachrichtentexte nur in offenen Prüffällen, gelöscht beim Erledigen oder nach 30 Tagen. Keine Telefonnummer, kein Code und kein Text in Logs.
- Der Pepper für den Nummern-Hash liegt nur im Secret-Speicher der Funktion, nie in der Datenbank.

## Nicht geprüft (braucht echten Meta-Zugang, WA0 rot)

- Echte Zustellungen von Meta, Deploy der Edge Function, Verhalten bei Meta-Retries über Stunden.
