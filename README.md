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

## Automatischer Abruf (Ordner `worker/`)

Ein Cloudflare Worker verbindet die Plattformen per OAuth, ruft täglich ab und speichert die Werte in KV.
Die App holt sie beim Öffnen (Daten → Automatischer Abruf). Einrichtung: [`worker/SETUP.md`](worker/SETUP.md).

| Plattform | API-Lage | Weg |
|---|---|---|
| Spotify for Artists | **keine öffentliche API** für S4A-Statistiken | CSV-Export importieren |
| SoundCloud | Self-Service-API seit Mai 2026, **nur mit Artist Pro** | Worker |
| TikTok | Login Kit + Display API (Follower, Likes, Videoaufrufe), Sandbox reicht fürs eigene Konto | Worker |
| Instagram | Instagram API mit Instagram Login, Creator-/Business-Konto, **keine Facebook-Seite nötig** | Worker |

OAuth-Secrets liegen nur im Worker, nie in der App. Tests: `cd worker && npm test`.
