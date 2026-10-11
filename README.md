# TravelSplit

Private, kostenlos betreibbare Reisekosten-PWA für Familie und Freunde.
React + Vite + TypeScript im Browser, Supabase (Postgres, Auth, Storage, Realtime) als Backend.

## Lokal starten

Voraussetzungen: Node 22, Docker.

```bash
npm ci
npx supabase start        # lokaler Supabase-Stack in Docker
npm run seed:dev          # Testnutzer Erwin/Larissa/Roger + Demoreise, schreibt .env.local
npm run dev               # http://127.0.0.1:5173, «Test-Login» mit erwin@dev.travelsplit.local / travelsplit-dev
```

## Prüfen

```bash
npm run lint && npm run typecheck
npm run test:unit         # Geldlogik
npm run test:integration  # RLS, RPCs, Angriffstests gegen den lokalen Stack
npm run test:e2e          # Klicktest auf Handy-Viewport (braucht seed:dev)
npm run build && npm run check:bundle-secrets
```

## Dokumentation

- [docs/p0-abnahmebericht.md](docs/p0-abnahmebericht.md): Stand P0, Nachweise, offene Punkte
- [docs/backup-restore.md](docs/backup-restore.md): Betreiber-Anleitung Backup und Wiederherstellung (R4)
- [docs/betreiber-runbook.md](docs/betreiber-runbook.md): Freigaben, Admin-Recovery, verlorene Gastzugänge

## Sicherheit

Im Frontend gibt es nur die öffentliche Supabase-URL und den Publishable Key. Service-Role-/Secret-Key,
Datenbankpasswort und Google-Client-Secret gehören nie ins Repository oder ins Bundle
(`npm run check:bundle-secrets` prüft das). WhatsApp ist nicht angebunden (`WHATSAPP_MODE=off`).
