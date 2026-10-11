# Betreiber-Runbook

Der Betreiber (Erwin) erledigt diese Schritte im **SQL-Editor des Supabase-Dashboards** oder mit `psql`.
Die Funktionen liegen im Schema `private`; sie sind über die App-API nicht erreichbar, auch nicht für
Mitglieder oder Reiseleitungen (getestet in `tests/integration/guest.test.ts`).

## Wer darf Reisen erstellen?

Nur Google-Konten auf der Freigabeliste. Gäste und Passwort-Konten nie.

```sql
select private.operator_grant_creator('name@gmail.com', 'erwin', 'Familie');   -- freigeben
select private.operator_revoke_creator('name@gmail.com');                       -- entziehen (wirkt sofort)
select email, granted_by, note, granted_at, revoked_at from private.creator_allowlist;  -- Liste
```

Entziehen ändert bestehende Reisen nicht; die Person bleibt Mitglied bzw. Reiseleitung ihrer Reisen.

## Reiseleitung wiederherstellen (R11)

Fall: Die Reiseleitung hat ihr Google-Konto verloren, ist verstorben oder nicht mehr erreichbar, und niemand
kann die Rolle in der App übergeben.

1. **Identität prüfen**, nie nur per Nachricht: Telefonat oder persönlich mit der neuen Person und möglichst
   einem weiteren Mitglied der Reise.
2. Reise und Person heraussuchen:

   ```sql
   select t.id as trip_id, t.title, p.display_name, p.linked_user_id, u.email
   from public.trips t
   join public.trip_people p on p.trip_id = t.id and p.status = 'active'
   join auth.users u on u.id = p.linked_user_id
   where t.title ilike '%Lissabon%';
   ```

3. Übertragen, mit Begründung (mindestens 10 Zeichen, landet im Audit):

   ```sql
   select private.operator_recover_admin('<trip_id>', '<linked_user_id>',
     'Erwin hat Google-Konto verloren; am 12.10. telefonisch mit Larissa und Roger bestätigt');
   ```

Die Funktion verweigert Personen, die nicht aktives Mitglied sind oder kein Google-Konto haben (Gäste).
Im Verlauf der Reise erscheint «Reiseleitung durch Betreiber wiederhergestellt».

## Gast hat Zugang verloren

Ein Gastzugang hängt am Browser. Ist er weg, gibt es **keine** Wiederherstellung über den Namen (SEC-08).
Vorgehen: Die Reiseleitung legt für die Person eine neue Einladung an. Hat die alte Gast-Person schon
Buchungen, braucht der neue Beitritt die Freigabe der Reiseleitung (R3). Gäste sollten ihren Zugang im Profil
mit «Mit Google sichern» an ein Google-Konto binden.

## Backup

Siehe [backup-restore.md](backup-restore.md).
