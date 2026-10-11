# WA-BLOCKED: WhatsApp-Bot nicht aktiviert

**Status:** BLOCKED (WA0 rot) · **Stand:** 11.10.2026

## Gründe

1. **Bedingungen:** Die WhatsApp Business Platform ist laut Meta nur für geschäftliche Nutzung, ausdrücklich nicht für persönliche. TravelSplit ist privat. Details und Quellen: [wa0-eligibility-cost-check.md](wa0-eligibility-cost-check.md).
2. **Keine Betreiberin:** Es gibt keine Firma, die den Dienst geschäftlich anbietet.
3. **Auftrag:** Keine Konten anlegen, nichts bei Meta registrieren, keine kostenpflichtigen Dienste. Daran wurde nichts geändert.

## Was trotzdem vorbereitet ist

| Teil | Ort | Zustand |
|---|---|---|
| Parser (WA-BOOK §6) | `src/domain/ingest/parse.ts` | in Gebrauch (Schnellerfassung) |
| Datenmodell, Verbindungscodes, Inbox, Prüffälle, Konfiguration | `supabase/migrations/20261011220000_whatsapp_adapter.sql` | angelegt, Modus `off` |
| Ein Buchungsdienst für alle Kanäle (`ActorContext`) | `private.create_expense_as` | in Gebrauch (App und CSV) |
| Webhook (Signatur, Schema, Idempotenz) | `supabase/functions/whatsapp-webhook/` | **nicht deployt** |
| Prüffall-Liste in der App | `src/features/quick/WhatsAppReview.tsx` | unsichtbar, solange keine Prüffälle existieren |
| Tests WA1-1 bis 12 | `tests/integration/whatsapp.test.ts` | grün, nur synthetische Nachrichten |

## Ersatz, der heute funktioniert

- **Schnellerfassung** im Reise-Cockpit: `Taxi 100 GEL alle`, `Essen 85 EUR Erwin Larissa`, `Hotel 200 EUR 50% Erwin 50% Larissa`. Öffnet das normale Formular vorausgefüllt.
- **Teilen aus WhatsApp (Android):** Nachricht lange drücken → Teilen → TravelSplit. Mit einem Reisecode (`#LIS26 …`) landet sie direkt in der richtigen Reise, sonst wählt man die Reise. Gespeichert wird erst nach Prüfung im Formular.
- iPhone: Text kopieren und in die Schnellerfassung einfügen (iOS unterstützt Web Share Target für PWAs nicht).
