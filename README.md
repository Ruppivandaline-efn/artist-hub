# Artist Hub

Handy-App (PWA), die Statistiken aus **Spotify for Artists, SoundCloud, TikTok und Instagram** an einem Ort zusammenführt.
Kein App Store, kein Server, keine Abhängigkeiten. Alle Daten bleiben auf dem Gerät.

## Funktionen

- **Übersicht**: Follower gesamt mit Veränderung, eine Kachel pro Plattform mit Sparkline und Aktualitäts-Hinweis,
  Follower-Wachstum in % (macht unterschiedlich große Plattformen vergleichbar), Wiedergaben im Zeitraum,
  automatische Auffälligkeiten (Wachstum, Einbrüche, veraltete Daten, Datenlücken, Engagement-Rate).
- **Plattformen**: Kennzahlen und Verlaufs-Charts pro Metrik (antippen/hovern für Werte).
- **Daten**: manuelle Eingabe, CSV-Import mit automatischer Spaltenerkennung, Tabelle, JSON-Backup.
- Zeitraum 7 / 28 / 90 Tage, Dark & Light Mode, offline nutzbar.

## Datenmodell

| Typ | Bedeutung | Auswertung |
|---|---|---|
| **Bestand** | aktueller Stand (Follower, Likes gesamt, Plays gesamt, Hörer) | letzter Wert − Wert zu Periodenbeginn |
| **Tageswert** | Menge an genau diesem Tag (Streams, Views, Interaktionen) | Summe über den Zeitraum, Vergleich mit Vorperiode nur bei ≥ 80 % Abdeckung |

Plattformen und Metriken stehen in `PLATFORMS` oben in `app.js` und lassen sich dort erweitern.

## Installieren aufs Handy

1. Ordner hosten (z. B. GitHub Pages, Netlify, Vercel – statische Dateien reichen).
2. Auf dem Handy öffnen → **iOS:** Teilen → „Zum Home-Bildschirm“ · **Android:** Menü → „App installieren“.

Lokal testen: `python3 -m http.server` im Ordner `artist-hub/`, dann `http://localhost:8000`.

> **Wichtig (iOS):** Safari löscht Website-Daten, die 7 Tage nicht benutzt wurden. Als Home-Bildschirm-App
> gilt das nicht, trotzdem regelmäßig **Backup exportieren**.

## Warum (noch) keine automatische Synchronisation?

| Plattform | API-Lage | Realistischer Weg |
|---|---|---|
| Spotify for Artists | **keine öffentliche API** für S4A-Statistiken | CSV-Export aus S4A importieren |
| SoundCloud | API-Zugang für neue Apps nur eingeschränkt | Werte manuell eintragen |
| TikTok | Display API liefert Follower/Likes/Video-Views, braucht App-Registrierung + OAuth | Phase 2 mit Backend |
| Instagram | Graph API nur für Business-/Creator-Konten mit verknüpfter Facebook-Seite | Phase 2 mit Backend |

OAuth-Secrets dürfen nicht in eine reine Client-App. Automatisches Abrufen braucht deshalb einen kleinen Server
(z. B. Serverless-Funktion mit täglichem Cron), der die Werte holt und dieselbe Datenstruktur befüllt.
