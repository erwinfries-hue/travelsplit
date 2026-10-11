# WA0: Zulässigkeit und Kosten des WhatsApp-Moduls

**Stand:** 11.10.2026 · **Ergebnis:** 🔴 nicht zulässig für die private Nutzung · `WHATSAPP_MODE=off`

Grundlage: WhatsApp-Spezifikation v1.2 §2, §3, §8 (WA0). Keine Rechtsberatung; die Auslegung ist aber eindeutig.

| Prüfpunkt | Befund (Quelle, abgerufen 11.10.2026) | Ampel |
|---|---|---|
| Zulässigkeit | WhatsApp Business Platform Terms (gültig ab 23.09.2026), Abs. 1: «These Platform Services are solely for your business or commercial use». Abs. 3: Nutzung «solely for business, commercial, and authorized purposes, and not for personal use». TravelSplit ist eine private Reisekasse für Familie und Freunde, also persönliche Nutzung. Ein Firmen- oder Business-Konto ändert daran nichts, solange der Zweck privat bleibt. [Quelle](https://www.whatsapp.com/legal/WhatsApp-Terms-for-WhatsApp-Business-Platform) | 🔴 |
| Betreiberin | Es gibt keine Rechtsperson, die TravelSplit geschäftlich betreibt. Erwin betreibt die App privat. | 🔴 |
| Sandbox / Testnummer | Braucht ebenfalls eine Meta-Developer-App und ein Business-Portfolio unter denselben Bedingungen. Darum auch keinen Sandbox-Test. | 🔴 |
| Voraussetzungen, falls je zulässig | Meta Business Portfolio, WhatsApp Business Account, eigene Nummer (nicht die private WhatsApp-Nummer), Business-Verifizierung, öffentlicher HTTPS-Webhook. Nichts davon ist vorhanden, nichts wurde angelegt. | 🟡 |
| Nachrichtenkosten | Offizielle Preisseite: eingehende Nachrichten kostenlos; freie Antworten im offenen 24-Stunden-Servicefenster kostenlos; Templates kosten je Land. Die Angabe «erste 1 000 Service-Antworten gratis» in der Spezifikation ist überholt. TravelSplit sendet nie (Outbound per Datenbank-Constraint gesperrt), Nachrichtenkosten sind also 0. [Quelle](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing) | 🟢 |
| Nummer | Kosten hängen vom Anbieter der Nummer ab, nicht von Meta. Nicht geprüft, weil keine Nummer beschafft werden soll. | 🟡 |
| Hosting Webhook | Supabase Edge Functions im Gratisplan (Kontingent laut Supabase-Preisseite, vor einem Einsatz neu prüfen). Mengenlimits in der Datenbank begrenzen die Verarbeitung (30 Nachrichten pro Absender und Stunde, 500 pro Tag). | 🟢 |
| Abschaltmechanik | Doppelt: `WHATSAPP_MODE` der Funktion (off = Route antwortet 404) und `private.whatsapp_config.mode` in der Datenbank (off = nichts wird gespeichert). Outbound per Check-Constraint unmöglich. | 🟢 |

## Entscheidung

Der echte WhatsApp-Bot bleibt **blockiert** (siehe [WA-BLOCKED.md](WA-BLOCKED.md)). Gebaut und getestet ist nur die
vorbereitete Architektur mit synthetischen Nachrichten ([wa1-security-test-results.md](wa1-security-test-results.md)).
Als sofort nutzbarer, kostenloser Ersatz gibt es die **Schnellerfassung** im Reise-Cockpit und das **Teilen aus WhatsApp**
an TravelSplit (Android). Beides füllt nur das normale Formular vor; gespeichert wird erst nach Prüfung.

Neu zu prüfen wäre WA0 nur, wenn eine Firma oder ein Verein TravelSplit geschäftlich anbietet, oder wenn Meta die
Bedingungen ändert. Dann gilt [wa2-activation-checklist.md](wa2-activation-checklist.md).
