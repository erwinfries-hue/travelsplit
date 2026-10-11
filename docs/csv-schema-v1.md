# TravelSplit CSV, Schema-Version 1

Eine Datei pro Reise. Export für alle Mitglieder, Import nur für die Reiseleitung einer aktiven Reise.
Beispiele: [export-beispiel.csv](examples/export-beispiel.csv), [import-vorlage.csv](examples/import-vorlage.csv)
(auch in der App unter *Export & Import → Vorlage herunterladen*).

## Format

| Eigenschaft | Wert |
|---|---|
| Zeichensatz | UTF-8 **mit BOM** (sonst zeigt Excel Umlaute falsch) |
| Trennzeichen | `;` (Excel DE/CH öffnet die Datei direkt in Spalten). Beim Import wird auch `,` erkannt. |
| Zeilenende | CRLF; beim Import auch LF |
| Quoting | RFC 4180. Alle Textfelder in `"…"`, `"` wird zu `""`. Zeilenumbrüche in Notizen sind erlaubt. |
| Beträge | **ganze Zahlen in Kleinsteinheiten** (Rappen/Cent; JPY ohne, KWD mit 3 Stellen). Keine Dezimaltrennzeichen, damit keine Spracheinstellung die Zahl verfälscht. |
| Kurse | `rate_scaled` = EUR pro 1 Einheit × 10¹⁰ (1,07 → `10700000000`) |
| Datum | `YYYY-MM-DD`; beim Import wird auch `T.M.JJJJ` akzeptiert (so speichert Excel DE/CH) |
| `*_display` | nur zum Lesen, wird beim Import ignoriert |

## Spalten

`schema_version;row_type;row_id;ref_id;date;title;person_name;counterparty_name;currency;amount_minor;base_currency;base_amount_minor;split_mode;share_value;rate_scaled;status;category;note;amount_display;source`

Die letzte Spalte `source` (Herkunft einer Ausgabe: `app`, `csv_import`, `whatsapp`) kam nachträglich dazu. Dateien
ohne diese Spalte bleiben gültig, weil Spalten über den Kopf gelesen werden; der Import ignoriert sie.

| `row_type` | Bedeutung und benutzte Spalten | Import |
|---|---|---|
| `trip` | Reise: `row_id`, `date` (Beginn), `title`, `base_currency`, `status`, `note` (Ende) | ignoriert |
| `person` | Person: `row_id`, `person_name`, `status` (`active`/`placeholder`/`removed`) | ignoriert (Personen entstehen aus den Namen) |
| `trip_fx` | Kurs: `row_id`=`currency`, `rate_scaled`, `status` (Revision), `date` | wird gesetzt, wenn die Reise noch keinen hat; abweichender Kurs = Fehler |
| `expense` | Kopfzeile einer Ausgabe: `row_id`, `date`, `title`, `person_name` (Zahler), `currency`, `amount_minor`, `base_amount_minor`, `split_mode` (`equal`/`fixed`/`percent`), `status` (`active`/`admin_reconstruction`/`deleted`), `category`, `note`, `source` | ja (`deleted` wird übersprungen) |
| `expense_share` | Anteil: `ref_id` = `row_id` der Ausgabe, `person_name`, `amount_minor` (Anteil Original), `base_amount_minor`, `share_value` (bei `fixed` Kleinsteinheiten, bei `percent` Prozent × 10 000; bei `equal` leer) | ja |
| `settlement` | Rückzahlung: `person_name` → `counterparty_name`, Original und eingefrorener Basisbetrag, `rate_scaled` (eingefrorener Kurs), `status` | **nein**, muss in der App gemeldet und vom Empfänger bestätigt werden |
| `settlement_reversal` | Storno: `ref_id` = Rückzahlung, `base_amount_minor`, `note` (Grund) | nein |

Gesamtbeträge stehen nur in der `expense`-Zeile; Anteilszeilen nie aufsummieren und mit dem Gesamtbetrag mischen.

## Import-Regeln

- Vorschau vor dem Buchen: Anzahl Ausgaben, neue Platzhalter, Kurse, übersprungene Zeilen, Fehler mit Zeilennummer.
- Die ganze Datei wird **in einer Transaktion** gebucht. Ein fehlerhafter Datensatz bricht alles ab; der Server nennt ihn.
- Der Server prüft jede Ausgabe mit denselben Regeln wie in der App (Beträge, Aufteilung, Kurse, Zahler).
- Namen werden ohne Gross-/Kleinschreibung bestehenden Personen zugeordnet; unbekannte Namen werden Platzhalter.
- Die SHA-256 des Dateiinhalts wird gespeichert. **Dieselbe Datei kann in dieselbe Reise nur einmal** importiert werden.
- Importierte Ausgaben tragen die Herkunft `csv_import`; Ausgaben mit fremdem Zahler sind als Admin-Rekonstruktion markiert.

## Schutz gegen Formel-Injection (DATA-04)

Textzellen, die (auch nach Leerzeichen, Tabs, CR/LF oder unsichtbaren Zeichen) mit `=`, `+`, `-`, `@` oder deren
Vollbreiten-Varianten beginnen, bekommen ein führendes `'`. Excel und LibreOffice zeigen sie als Text an. Der Import
entfernt genau dieses Zeichen wieder, sodass ein Titel Export → Import unverändert übersteht.

Nachweis: `tests/unit/csv.test.ts` (Angriffsliste, Property-Tests) und `npm run test:csv-office` mit echtem
LibreOffice: Kontrolle ohne Schutz ergibt Formeln, TravelSplit-Export ergibt keine, und nach Speichern als xlsx
und Zurückexportieren liest TravelSplit alle Titel wieder ein.
