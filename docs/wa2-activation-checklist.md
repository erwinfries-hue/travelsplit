# WA2: Checkliste für eine spätere Aktivierung

**Nicht starten**, solange WA0 rot ist ([wa-blockers.md](wa-blockers.md)). Jeder Schritt mit Kosten oder Konto braucht
Erwins ausdrückliche Zustimmung.

## 1. Voraussetzungen (Erwin)

- [ ] WA0 neu bewertet und positiv: eine Rechtsperson betreibt TravelSplit geschäftlich, Bedingungen schriftlich geprüft.
- [ ] Freigabe von Kosten und Nummer: Anbieter, Monatskosten, Obergrenze. Verweis in `approval_reference` eintragen.
- [ ] Meta Business Portfolio, WhatsApp Business Account, eigene Nummer, Webhook-Abo nur für das Feld `messages`.

## 2. Secrets (nur im Supabase-Secret-Speicher, nie im Repo)

```
npx supabase secrets set WHATSAPP_MODE=sandbox WHATSAPP_APP_SECRET=… WHATSAPP_VERIFY_TOKEN=… \
  WHATSAPP_PHONE_NUMBER_ID=… WHATSAPP_ID_PEPPER=$(openssl rand -hex 32)
```

Den Pepper nie wechseln, sonst müssen alle Verbindungen neu hergestellt werden.

## 3. Deploy

- [ ] `npx supabase functions deploy whatsapp-webhook --no-verify-jwt` (Meta sendet kein Supabase-JWT; die HMAC-Signatur ist die Authentifizierung).
- [ ] Vorher prüfen, dass der Bundler den gemeinsamen Parser aus `src/domain/ingest/` einbindet (lokal mit `npx supabase functions serve` testen).
- [ ] Datenbank: `update private.whatsapp_config set mode = 'sandbox', allowed_phone_number_id = '…', business_number = '…', approval_reference = '…' where id = 1;`

## 4. Abnahme mit 2–3 echten Testpersonen

- [ ] Reiseleitung erstellt unter Personen einen Verbindungscode (UI dafür noch bauen, RPC `create_whatsapp_link` existiert), Person sendet `LINK …` selbst.
- [ ] Eindeutige Nachricht bucht, unklare landet als Prüffall, Duplikat bucht nicht doppelt.
- [ ] Meta-Rechnung nach einem Monat geprüft.
- [ ] Erst dann `mode = 'production'`.

## Abschalten

`update private.whatsapp_config set mode = 'off' where id = 1;` wirkt sofort, unabhängig vom Deploy.
Zusätzlich `WHATSAPP_MODE=off` setzen; dann antwortet die Funktion mit 404.
