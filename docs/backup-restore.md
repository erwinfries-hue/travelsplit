# Backup und Wiederherstellung (R4)

Ziel: Eine Reise mit allen Ausgaben, Kursen, bestätigten Zahlungen, Belegfotos und Abschluss-Snapshots
lässt sich aus einer verschlüsselten Datei in ein **leeres, separates** Supabase-Projekt zurückholen,
ohne dass sich ein Saldo um einen Cent ändert.

Alles läuft auf dem Rechner des Betreibers. Kein Cloud-Dienst, kein Konto, keine Kosten.

## Was gesichert wird

| Teil | Inhalt |
|---|---|
| `db/data.sql` | Daten aller Tabellen in `public` und `private` sowie `auth.users` und `auth.identities` (Logins bleiben gültig) |
| `db/schema.sql` | Schema zur Kontrolle; die Wiederherstellung nutzt die Migrationen aus dem Repo |
| `storage/receipts/` | alle Belegfotos aus dem privaten Bucket |
| `manifest.json` | Migrationsstände, Zeilenzahlen je Tabelle, SHA-256 jeder Datei und jedes Belegs |

Nicht gesichert: Sitzungen und Refresh-Tokens (alle Geräte melden sich nach einer Wiederherstellung neu an).

Die Datei wird mit [age](https://age-encryption.org) für den öffentlichen Schlüssel des Betreibers
verschlüsselt. Der private Schlüssel liegt nur offline (z. B. USB-Stick plus Passwortmanager).

## Einmalig einrichten

```bash
age-keygen -o ~/travelsplit-backup-key.txt     # privaten Schlüssel offline aufbewahren
grep 'public key' ~/travelsplit-backup-key.txt # age1… = BACKUP_AGE_RECIPIENT
```

`pg_dump` muss dieselbe Hauptversion wie der Server haben (Supabase: 17). Ist lokal eine ältere installiert,
`PG_DUMP` auf ein passendes Programm setzen.

## Backup erstellen

Die Werte stehen im Supabase-Dashboard unter *Project Settings*. Sie werden nur in der eigenen Shell gesetzt,
nie in Dateien im Repo.

```bash
export SUPABASE_DB_URL='postgresql://postgres.<ref>:<passwort>@<pooler-host>:5432/postgres'
export SUPABASE_URL='https://<ref>.supabase.co'
export SUPABASE_SECRET_KEY='<secret key>'
export BACKUP_AGE_RECIPIENT='age1…'
scripts/backup/backup.sh            # schreibt backups/travelsplit-backup-<UTC>.tar.age und .sha256
```

Empfehlung: einmal pro Monat und vor jedem grösseren Update. Die Datei an zwei Orten ablegen.

## Wiederherstellen

1. Neues, leeres Supabase-Projekt anlegen (oder lokal `npx supabase start` in einem separaten Ordner).
2. Migrationen anwenden (`npx supabase db push` bzw. lokal automatisch beim Start).
3. Wiederherstellen:

```bash
export RESTORE_DB_URL=… RESTORE_SUPABASE_URL=… RESTORE_SECRET_KEY=…
export RESTORE_CONFIRM_HOST='<ref>.supabase.co'   # Schutz gegen Verwechslung des Zielprojekts
scripts/backup/restore.sh backups/travelsplit-backup-<UTC>.tar.age ~/travelsplit-backup-key.txt
```

Das Skript bricht ab, wenn
- die Prüfsumme der Archivdatei oder einer enthaltenen Datei nicht stimmt,
- das Ziel nicht leer ist,
- die Migrationsstände von Backup und Ziel abweichen,
- `RESTORE_CONFIRM_HOST` nicht zum Ziel passt.

Die Daten werden in **einer** Transaktion geladen; bei einem Fehler bleibt das Ziel leer. Danach vergleicht
das Skript Zeilenzahlen und Beleg-Hashes mit dem Manifest.

4. Google-Login im neuen Projekt einrichten (Client-ID/Secret im Supabase-Dashboard, nicht im Repo) und die
   Frontend-Umgebungsvariablen auf das neue Projekt umstellen.

## Probe (automatisiert, nur lokal)

`npm run probe:backup` baut auf dem lokalen Stack eine Reise mit Erwin, Larissa und Roger auf (EUR, CHF, USD,
Kursänderung, bestätigte Zahlung, zwei Fotos, Abschluss), sichert, stellt in einen **zweiten lokalen Stack**
wieder her und prüft dort 19 Punkte. Benötigt `RESTORE_STACK_DIR` (Ordner mit eigener `supabase/config.toml`,
anderer `project_id` und anderen Ports). Ergebnis der Probe vom 2026-10-11: siehe
[p0-abnahmebericht.md](p0-abnahmebericht.md#m4-backup-restore-probe-r4).
