# Einrichtung: automatischer Abruf (Cloudflare Worker)

Reihenfolge einhalten: erst Worker, dann Entwicklerportale (die brauchen die Worker-Adresse als Redirect-URI).
**Secrets nie in Chats, Issues oder ins Repo schreiben** – nur in Cloudflare unter „Variables and Secrets“.

## 1. KV-Speicher anlegen
Cloudflare-Dashboard → **Storage & Databases → KV → Create** → Name `artist-hub`.
Die angezeigte **Namespace-ID** (keine geheime Angabe) in `worker/wrangler.toml` bei `id = …` eintragen.

## 2. Worker aus GitHub deployen
Dashboard → **Workers & Pages → Create → Import a repository** → GitHub verbinden → Repo `artist-hub`.
- Project name: `artist-hub-sync` (muss zum `name` in `wrangler.toml` passen)
- Root directory: `worker`
- Deploy command: `npx wrangler deploy`

Danach hat der Worker eine Adresse wie `https://artist-hub-sync.<dein-name>.workers.dev`.
Aufrufen → es muss „Artist Hub Sync läuft.“ erscheinen.

## 3. App-Schlüssel setzen
Worker → **Settings → Variables and Secrets → Add** → Typ **Secret**:
- `APP_KEY` = langes Zufallspasswort (mind. 32 Zeichen, z. B. aus dem Passwort-Manager)

Diesen Schlüssel trägst du später in der App unter **Daten → Automatischer Abruf** ein.

## 4. Plattformen

Redirect-URIs (exakt so, mit deiner Worker-Adresse):

| Plattform | Redirect-URI |
|---|---|
| Instagram | `https://artist-hub-sync.<dein-name>.workers.dev/auth/instagram/callback` |
| TikTok | `https://artist-hub-sync.<dein-name>.workers.dev/auth/tiktok/callback` |
| SoundCloud | `https://artist-hub-sync.<dein-name>.workers.dev/auth/soundcloud/callback` |

### Instagram (Creator-Konto)
Neue Meta-Apps (ab Okt. 2026) bekommen nur noch **„API setup with Unified login“**. Der Worker unterstützt das,
wenn das Secret `IG_CONFIG_ID` gesetzt ist. (Hinweis: Diese Schritte beruhen auf Entwickler-Berichten, Metas Doku dazu ist dünn.)

1. **Business-Portfolio** anlegen (business.facebook.com) und dein Instagram-Konto dort hinzufügen
   (Einstellungen → Konten → Instagram-Konten).
2. App mit Anwendungsfall „Messaging und Content auf Instagram verwalten“ → **API setup with Unified login**.
3. **Neue Konfiguration erstellen**: Login-Variante „Allgemein“, Token „Systemnutzer-Zugriffstoken“,
   Asset „Instagram-Konto“. Berechtigungen: `instagram_basic`, `instagram_manage_insights`, `business_management`.
   Fehlen `instagram_manage_insights`/`business_management` im Editor: Produkt **Facebook Login for Business**
   → **Konfigurationen** → dieselbe Konfiguration **bearbeiten** und dort hinzufügen.
4. **Weiterleitungs-URL** registrieren: `https://<worker>/auth/instagram/callback`.
5. Secrets im Worker:
   - `IG_CLIENT_ID` = App-ID (App-Einstellungen → Allgemeines)
   - `IG_CLIENT_SECRET` = App-Geheimcode (ebenda)
   - `IG_CONFIG_ID` = ID der Konfiguration (Facebook Login for Business → Konfigurationen)

Ältere Apps mit „API-Einrichtung mit Instagram-Login“: `IG_CONFIG_ID` weglassen, dann Instagram-App-ID/-Geheimcode verwenden.

### TikTok
1. developers.tiktok.com → **Manage apps → Connect an app**.
2. Produkte hinzufügen: **Login Kit** und **Display API**; Scopes `user.info.basic`, `user.info.stats`, `video.list`.
3. Bei Login Kit → Web: Redirect-URI eintragen.
4. **Sandbox** anlegen und dein TikTok-Konto als Target User hinzufügen (so ist keine App-Prüfung nötig).
5. Secrets im Worker: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` (aus der Sandbox, nicht Production).

### SoundCloud (Artist Pro)
1. developers.soundcloud.com → **Register an app** (mit dem Artist-Pro-Konto einloggen).
2. Redirect-URI eintragen.
3. Secrets im Worker: `SC_CLIENT_ID`, `SC_CLIENT_SECRET`.

### Spotify
Keine API für Spotify-for-Artists-Statistiken. Weiter per CSV-Export importieren.

## 5. In der App verbinden
App → **Daten → Automatischer Abruf** → Worker-Adresse + App-Schlüssel → „Speichern & abrufen“.
Dann bei jeder Plattform **Verbinden** tippen und den Login bestätigen.
Der Worker ruft danach täglich um ~05:17 Uhr ab; die App holt beim Öffnen neue Werte.

## Was abgerufen wird

| Plattform | Werte | Datum |
|---|---|---|
| Instagram | Follower; Aufrufe und Interaktionen des Vortags | heute / gestern |
| TikTok | Follower, Likes gesamt; Video-Aufrufe = Zuwachs der Summe aller Videoaufrufe (ab dem 2. Tag) | heute / gestern |
| SoundCloud | Follower, Plays gesamt, Likes gesamt (Summe deiner Tracks) | heute |

## Fehlerbehebung
- Status in der App zeigt die letzte Fehlermeldung je Plattform.
- „Neu verbinden“, wenn ein Token abgelaufen ist (z. B. Instagram nach 60 Tagen ohne Abruf, TikTok nach 365 Tagen).
- Logs: Cloudflare → Worker → **Observability / Logs**.
