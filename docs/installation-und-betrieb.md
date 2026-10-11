# Installation, Veröffentlichung und Betrieb

Für einen technisch interessierten Betreiber, der nicht täglich programmiert (Auftrag §14). Alle Dienste im
**Gratisplan**. Preise und Limits ändern sich: Vor dem Start die verlinkten Seiten kurz prüfen.

## 1. Benötigte Konten (alle kostenlos)

| Konto | Wofür | Hinweis |
|---|---|---|
| GitHub | Code, Versionen, automatische Tests | privates Repo `erwinfries-hue/travelsplit` besteht |
| Supabase | Datenbank, Login, Fotos, Live-Aktualisierung | Free-Plan: 2 Projekte, 500 MB Datenbank, 1 GB Dateien, **keine automatischen Backups**, Pause nach 7 Tagen ohne Nutzung ([Preise](https://supabase.com/pricing)) |
| Cloudflare | Webseite ausliefern (Pages) | Free-Plan: 500 Builds/Monat ([Limits](https://developers.cloudflare.com/pages/platform/limits/)) |
| Google Cloud | «Mit Google anmelden» | nur OAuth-Client, keine kostenpflichtigen APIs |

Keine Kreditkarte hinterlegen, wo es nicht verlangt wird. WhatsApp/Meta wird **nicht** gebraucht.

## 2. Lokal starten und prüfen

Voraussetzungen: Node 22, Docker.

```bash
git clone https://github.com/erwinfries-hue/travelsplit.git && cd travelsplit
npm ci
npx supabase start         # lokale Datenbank in Docker
npm run seed:dev           # Testnutzer und Demoreise, schreibt .env.local
npm run dev                # http://127.0.0.1:5173
npm run lint && npm run typecheck && npm run test:unit && npm run test:integration
npm run test:e2e
npm run build && npm run check:bundle-secrets
```

## 3. Supabase-Projekt

1. Auf supabase.com ein Projekt anlegen, Region **Frankfurt (eu-central-1)**, starkes Datenbankpasswort im Passwortmanager speichern.
2. Migrationen einspielen (auf dem eigenen Rechner):
   ```bash
   npx supabase login
   npx supabase link --project-ref <projekt-ref>
   npx supabase db push
   ```
3. Authentication → Sign In / Providers:
   - **Anonymous sign-ins: an** (Gäste per Einladung).
   - **Manual linking: an** (Gast → Google-Upgrade).
   - Google: aktivieren, Client-ID und Client-Secret aus Schritt 4 eintragen. Das Secret steht nur hier, nie im Repo.
4. Authentication → URL Configuration: **Site URL** = Cloudflare-Adresse aus Schritt 5 (z. B. `https://travelsplit.pages.dev`), dieselbe Adresse auch unter Redirect URLs.
5. Project Settings → API: **Project URL** und **Publishable key** notieren. Den Secret/Service-Role-Key nirgends eintragen.
6. Storage: Der private Bucket `receipts` entsteht durch die Migration; nichts manuell freigeben.

## 4. Google-Login

1. console.cloud.google.com → neues Projekt «TravelSplit».
2. OAuth-Zustimmungsbildschirm (Google Auth Platform): Zielgruppe **Extern**, App-Name, Support-E-Mail. Scopes **nur** `openid`, `…/auth/userinfo.email`, `…/auth/userinfo.profile`. Kein Logo hochladen (sonst verlangt Google eine Markenprüfung).
3. Clients → OAuth-Client-ID → Typ «Webanwendung». Autorisierte Weiterleitungs-URI: `https://<projekt-ref>.supabase.co/auth/v1/callback`.
4. Veröffentlichungsstatus: Im Modus «Testen» dürfen nur eingetragene Testnutzer (max. 100) sich anmelden. Für die Familie reicht das; sonst «In Produktion» setzen. Mit den drei Basis-Scopes ist keine Google-Prüfung nötig (beim Einrichten kontrollieren, Google passt das gelegentlich an).

## 5. Cloudflare Pages

1. Workers & Pages → Pages → mit GitHub verbinden → Repo `travelsplit`.
2. Build-Befehl `npm run build`, Ausgabeordner `dist`, Produktionszweig `main`.
3. Umgebungsvariablen (nur öffentliche Werte): `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_DEV_LOGIN=false`, `NODE_VERSION=22`.
4. Keine Functions anlegen. `public/_headers` setzt Sicherheits-Header; Unterseiten wie `/trips/…` liefert Pages automatisch als App aus.
5. Nach dem ersten Deploy die Adresse in Supabase (Schritt 3.4) eintragen.

## 6. Erste Freischaltung und Testpersonen

Im Supabase-Dashboard → SQL Editor (nur Betreiber):

```sql
select private.operator_grant_creator('erwin@gmail.com', 'erwin', 'Betreiber');
```

Danach mit Google anmelden, eine Reise erstellen, unter **Personen** zwei Testpersonen anlegen und deren
Einladungslinks per WhatsApp schicken. Es gibt keinen offenen Registrierungslink.

## 7. Installation auf dem Handy

- **Galaxy S25 (Chrome):** Adresse öffnen → Menü ⋮ → «Zum Startbildschirm hinzufügen» / «App installieren». TravelSplit erscheint dann auch im Teilen-Menü (Schnellerfassung aus WhatsApp).
- **iPhone (Safari):** Adresse öffnen → Teilen-Symbol → «Zum Home-Bildschirm». Einschränkungen: kein Teilen-Ziel; Google-Login kann kurz Safari öffnen.
- TravelSplit ist in keinem App Store.

## 8. Tagesbetrieb

| Aufgabe | Wo |
|---|---|
| Reise, Personen, Einladungen, Kurse | in der App (Reiseleitung) |
| Ausgabe mit Foto, Schnellerfassung | Reise-Cockpit |
| Zahlungseingang bestätigen | Salden |
| Abschluss, CSV, PDF | Einstellungen / Export & Import |
| Backup (vor jeder Reise-Pause und jedem Update) | [backup-restore.md](backup-restore.md) |
| Admin-Recovery, verlorener Gastzugang, Freischaltungen | [betreiber-runbook.md](betreiber-runbook.md) |
| Reise endgültig löschen | Einstellungen einer abgeschlossenen Reise |
| Supabase pausiert (nach 7 Tagen ohne Nutzung) | Dashboard → «Restore project». Solange bleiben neue Ausgaben als «Nicht gesendet»-Entwurf auf dem Handy; es wird nichts vorgetäuscht. |

## 9. Updates

1. Backup erstellen.
2. Änderungen auf einem Branch, Pull Request, Tests grün.
3. Neue Migrationen mit `npx supabase db push` einspielen, **dann** `main` mergen (Cloudflare baut automatisch).
4. Installierte Apps holen die neue Version beim nächsten Öffnen.
5. Preis-/Limitänderungen der Anbieter: Supabase-Usage-Seite monatlich ansehen; bei Überschreitung droht keine Rechnung, solange kein Bezahlplan aktiv ist.

## 10. Übergabe-Inventar

| Was | Wo |
|---|---|
| Code, Tests | dieses Repository |
| Datenbankschema | `supabase/migrations/` (9 Migrationen) |
| Umgebungsvariablen | `.env.example` (Frontend), Supabase-Dashboard (Google-Secret) |
| Testbelege | `docs/p0-abnahmebericht.md`, `docs/p1-abnahmebericht.md`, `docs/wa1-security-test-results.md` |
| Risiken | `docs/p1-abnahmebericht.md` (Risikoregister) |
| Handbücher | `docs/handbuch.md` (DE), `docs/handbook.md` (EN) |
