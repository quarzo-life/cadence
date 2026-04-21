# Spec — Sync bidirectionnel Notion ↔ Google Calendar

> Document de spécification destiné à Claude Code. Objectif : implémenter un job de synchronisation **bidirectionnel** entre une base Notion de tâches et les Google Calendars des membres d'un Google Workspace.

---

## 1. Contexte & objectif

Une équipe travaille dans un **Google Workspace commun**. Les tâches sont gérées dans une **base Notion unique**. Chaque tâche a un champ `Owner` de type `Person` (membre du workspace).

Le système synchronise dans les deux sens, avec une asymétrie claire :

**Sens 1 — Notion → Google Calendar** (toutes les tâches)
Toute tâche datée de la base Notion doit apparaître dans le Google Calendar `primary` de son owner. Si l'owner change, l'event est déplacé. Si la tâche est archivée/supprimée, l'event est supprimé. Notion est la source de vérité canonique pour le contenu (titre, date, owner).

**Sens 2 — Google Calendar → Notion** (events marqués `NOTION`)
Les events dont le titre commence par `NOTION` (marqueur d'ingestion, configurable) dans les calendriers surveillés doivent créer une page dans la base Notion, avec la personne du calendar comme owner. Le marqueur est **retiré du titre** lors de la création de la page Notion.

**Asymétrie explicite** :
- Le marqueur `NOTION` est un **déclencheur d'ingestion initiale uniquement**. Une fois l'event lié à une page Notion, on suit toutes ses modifs (titre, date) sans re-vérifier le marqueur. Le titre Google suit ensuite celui de Notion (sans préfixe).
- Tous les events créés depuis Notion portent `extendedProperties.private.notion_page_id` et sont **exclus du flux G→N** quel que soit leur titre (prévention de boucle).

---

## 2. Stack technique

- **Runtime** : Deno (v2.x)
- **Langage** : TypeScript strict
- **Base de données** : SQLite (fichier local sur volume Railway)
- **Hébergement** : Railway (service + volume + cron schedule)
- **Dépendances** :
  - `npm:@notionhq/client@^2.2.15` — SDK officiel Notion
  - `jsr:@db/sqlite@^0.12` — bindings SQLite natifs pour Deno
- **Auth Google** : Web Crypto API native. Service Account + Domain-Wide Delegation.

Aucune autre dépendance. Pas de framework HTTP, pas d'ORM, pas de lib Google.

---

## 3. Architecture d'exécution

Script CLI qui s'exécute, fait son travail, et exit. Railway relance via cron.

Deux modes :

| Commande | Fréquence | Action |
|---|---|---|
| `deno run main.ts` (défaut) | toutes les **5 min** | Incremental — 2 passes : (1) Notion → Google, (2) Google → Notion |
| `deno run main.ts reconcile` | déclenché automatiquement si `RECONCILE_INTERVAL_HOURS` écoulées | Full scan Notion + détection hard-deletes |

Recommandation : **un seul cron toutes les 5 min**. Le mode incremental déclenche automatiquement la reconciliation interne si nécessaire. Pas de double config cron.

**Ordre des passes dans un run incremental** (important pour la cohérence) :
1. D'abord **Notion → Google** : les changements côté Notion sont prioritaires (source canonique des tâches).
2. Ensuite **Google → Notion** : ingestion des nouveaux events marqués + updates des events liés.

Ce ordre évite qu'un event fraîchement créé par la passe 1 soit (à tort) candidat à l'ingestion en passe 2 — il est de toute façon protégé par son `notion_page_id` en extendedProperties, mais l'ordre garantit la cohérence la plus fraîche.

---

## 4. Prérequis externes

### 4.1 Google Cloud

1. Créer un projet GCP (ou réutiliser).
2. Activer l'API **Google Calendar**.
3. Créer un **Service Account** (ex. `notion-sync`).
4. Générer une **clé JSON** → sauvegarder `client_email` et `private_key`.
5. Noter le **Client ID numérique** du SA (pas le `client_email`, l'ID numérique).
6. Admin Workspace → `admin.google.com` → **Sécurité** → **Contrôles des API** → **Délégation à l'échelle du domaine** → **Ajouter** :
   - Client ID : celui du SA
   - Scope : `https://www.googleapis.com/auth/calendar`

### 4.2 Notion

1. Créer une **intégration interne** sur `https://www.notion.so/profile/integrations`.
2. Cocher la capability **"Read user information including email addresses"**. Essentiel.
3. Cocher les capabilities **Read / Update / Insert content** (on crée et modifie des pages en G→N).
4. Ouvrir la database des tâches → menu `...` → **Connexions** → ajouter l'intégration.

### 4.3 Schéma de la base Notion

| Nom (par défaut) | Type | Obligatoire | Rôle |
|---|---|---|---|
| `Name` | Title | ✅ | Titre tâche ↔ summary event (sans le marqueur) |
| `Date` | Date | ✅ | Date/plage ↔ start/end event |
| `Owner` | Person | ✅ | Personne assignée ↔ calendrier (primary de cet email) |
| `Status` | Status ou Select | ⚠️ | Optionnel. Valeurs archivées → suppression de l'event. |

Noms configurables via env vars (§5). **Le code ne modifie jamais le schéma Notion.**

### 4.4 Utilisateurs surveillés (direction G→N)

Pour l'ingestion depuis Google, il faut une **allowlist explicite** d'emails à surveiller (`GOOGLE_WATCH_EMAILS`). Si vide, la direction G→N est désactivée — seul le flux N→G tourne.

Recommandation : mettre dans l'allowlist tous les emails qui sont (ou seront) owners de tâches Notion.

---

## 5. Variables d'environnement

| Variable | Requis | Défaut | Description |
|---|---|---|---|
| `NOTION_TOKEN` | ✅ | — | Token intégration Notion |
| `NOTION_DATABASE_ID` | ✅ | — | ID database (32 chars hex) |
| `NOTION_PROP_TITLE` | ❌ | `Name` | Nom propriété Title |
| `NOTION_PROP_DATE` | ❌ | `Date` | Nom propriété Date |
| `NOTION_PROP_OWNER` | ❌ | `Owner` | Nom propriété Person |
| `NOTION_PROP_STATUS` | ❌ | *(vide)* | Nom propriété Status. Si vide, détection par status désactivée. |
| `NOTION_STATUS_ARCHIVED_VALUES` | ❌ | `Archived,Done,Cancelled` | Valeurs qui déclenchent suppression (CSV) |
| `GOOGLE_SA_EMAIL` | ✅ | — | Email du service account |
| `GOOGLE_SA_PRIVATE_KEY` | ✅ | — | Clé privée PEM. Railway stocke les `\n` littéraux — reconversion nécessaire. |
| `GOOGLE_WATCH_EMAILS` | ❌ | *(vide)* | CSV des emails dont on ingère les events marqués. Si vide, G→N désactivé. |
| `GOOGLE_SYNC_KEYWORD` | ❌ | `NOTION` | Marqueur d'ingestion (début de titre, case-insensitive, word boundary) |
| `DEFAULT_EVENT_DURATION_MIN` | ❌ | `30` | Durée par défaut si pas d'heure de fin |
| `SYNC_LOOKBACK_MIN` | ❌ | `15` | Fenêtre de recouvrement pour l'incrémental Notion (minutes) |
| `SYNC_TIMEZONE` | ❌ | `Europe/Paris` | TZ pour les events datés |
| `RECONCILE_INTERVAL_HOURS` | ❌ | `24` | Intervalle min. entre deux reconciliations complètes |
| `DATABASE_PATH` | ❌ | `/data/sync.db` | Chemin SQLite. `/data` = volume Railway. |
| `LOG_LEVEL` | ❌ | `info` | `debug` \| `info` \| `warn` \| `error` |

Un `.env.example` doit être fourni.

---

## 6. Schéma SQLite

```sql
-- État de sync par tâche (une ligne = un couple Notion page ↔ Google event)
CREATE TABLE IF NOT EXISTS synced_tasks (
  notion_page_id        TEXT PRIMARY KEY,
  google_event_id       TEXT NOT NULL,
  google_calendar_id    TEXT NOT NULL,          -- email owner = id du calendar primary
  source                TEXT NOT NULL,          -- 'notion' | 'google' : qui a créé la ligne
  notion_last_edited_at TEXT NOT NULL,          -- ISO 8601
  google_updated_at     TEXT,                   -- ISO 8601, dernière mtime connue côté Google
  last_synced_at        TEXT NOT NULL,          -- ISO 8601
  title                 TEXT                    -- debug/logs
);

CREATE INDEX IF NOT EXISTS idx_synced_tasks_calendar
  ON synced_tasks(google_calendar_id);

CREATE INDEX IF NOT EXISTS idx_synced_tasks_event
  ON synced_tasks(google_event_id);

-- syncToken par calendrier surveillé (direction G→N)
CREATE TABLE IF NOT EXISTS google_sync_tokens (
  calendar_id     TEXT PRIMARY KEY,              -- email user
  sync_token      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Historique des runs pour observabilité
CREATE TABLE IF NOT EXISTS sync_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  mode            TEXT NOT NULL,                 -- 'incremental' | 'reconcile'
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  status          TEXT NOT NULL,                 -- 'running' | 'success' | 'failed'
  -- stats direction N→G
  n2g_seen        INTEGER NOT NULL DEFAULT 0,
  n2g_created     INTEGER NOT NULL DEFAULT 0,
  n2g_updated     INTEGER NOT NULL DEFAULT 0,
  n2g_moved       INTEGER NOT NULL DEFAULT 0,
  n2g_deleted     INTEGER NOT NULL DEFAULT 0,
  n2g_skipped     INTEGER NOT NULL DEFAULT 0,
  -- stats direction G→N
  g2n_seen        INTEGER NOT NULL DEFAULT 0,
  g2n_created     INTEGER NOT NULL DEFAULT 0,
  g2n_updated     INTEGER NOT NULL DEFAULT 0,
  g2n_deleted     INTEGER NOT NULL DEFAULT 0,
  g2n_skipped     INTEGER NOT NULL DEFAULT 0,
  errors          INTEGER NOT NULL DEFAULT 0,
  error_detail    TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_ended_at
  ON sync_runs(ended_at DESC);

-- Métadonnées clé/valeur
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Migrations : `migrations.sql` joué à chaque démarrage via `CREATE TABLE IF NOT EXISTS`. Pas de versioning v1.

---

## 7. Structure du projet

```
/
├── deno.json
├── Dockerfile
├── .env.example
├── .gitignore
├── README.md
├── main.ts                 # entrypoint, dispatch mode
├── config.ts               # env vars
├── db.ts                   # init SQLite + helpers
├── migrations.sql
├── logger.ts               # logger structuré
├── notion.ts               # Notion API : query, parse, create, update, archive
├── google-auth.ts          # JWT RS256 + impersonation DWD
├── calendar.ts             # Google Calendar API v3
├── sync-n2g.ts             # direction Notion → Google
├── sync-g2n.ts             # direction Google → Notion
├── sync.ts                 # orchestration + reconcile
└── tests/
    ├── notion.test.ts
    ├── calendar-body.test.ts
    ├── keyword-match.test.ts
    ├── sync-n2g.test.ts
    └── sync-g2n.test.ts
```

---

## 8. Logique de synchronisation

### 8.1 Représentation d'une tâche Notion en mémoire

```typescript
interface NotionTask {
  pageId: string;
  title: string;
  dateStart: string;          // ISO
  dateEnd: string | null;
  isAllDay: boolean;
  ownerEmail: string | null;
  ownerName: string | null;
  statusValue: string | null;
  lastEditedAt: string;       // ISO
  url: string;
  isArchived: boolean;        // page.archived OU status ∈ archived values
}
```

### 8.2 Représentation d'un Google event en mémoire

```typescript
interface GoogleEventSummary {
  eventId: string;
  calendarId: string;         // email du owner du calendar
  status: 'confirmed' | 'tentative' | 'cancelled';
  summary: string;            // titre brut
  description: string | null;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  updated: string;            // ISO
  notionPageId: string | null; // extendedProperties.private.notion_page_id
}
```

### 8.3 Construction d'un event Google depuis une NotionTask

- **All-day** (`isAllDay = true`) : `start: { date: "YYYY-MM-DD" }`, `end: { date: dateEnd + 1j ou dateStart + 1j }` (fin **exclusive**).
- **Daté** : `start: { dateTime: ISO, timeZone: SYNC_TIMEZONE }`, pareil pour `end`. Si `dateEnd` absent → `end = dateStart + DEFAULT_EVENT_DURATION_MIN`.
- `summary` = `title`
- `description` = `"Source Notion: {url}"`
- `extendedProperties.private.notion_page_id` = `pageId`

### 8.4 Construction d'une page Notion depuis un GoogleEventSummary

- `Name` = titre strippé du marqueur (voir §8.8)
- `Date` = convertir `start`/`end` Google au format attendu par Notion (avec `time_zone` si daté)
- `Owner` = résoudre l'email du calendrier vers un user Notion via `users.list` (cache en mémoire par run). Si aucun user Notion ne matche, log `warn` et ne pas créer la page.
- Optionnellement un bloc paragraphe au body : lien vers l'event Google (`https://www.google.com/calendar/event?eid=...` est instable — préférer stocker `htmlLink` de l'event dans une propriété ou la description). **v1 : pas de contenu de page, seulement les propriétés.**

### 8.5 Direction N→G (passe 1 du mode incremental)

Logique identique à la spec précédente :

```
1. since = started_at(dernier run success) - SYNC_LOOKBACK_MIN
2. Query Notion : last_edited_time >= since ET Date is_not_empty
3. Pour chaque NotionTask parsée :

   a. Si isArchived OU ownerEmail == null :
      - Si row SQLite existe → DELETE event (best-effort) + DELETE row → n2g_deleted++
      - Sinon → n2g_skipped++
      - continue

   b. Chercher row SQLite par notion_page_id :

      - Row absente :
        * Filet : events.list avec privateExtendedProperty notion_page_id={id}
        * Si trouvé → PATCH + INSERT row (source='notion') → n2g_updated++
        * Sinon → CREATE event + INSERT row (source='notion') → n2g_created++

      - Row présente, calendar_id != ownerEmail :
        * DELETE event sur ancien calendar (ignorer 404/410)
        * CREATE event sur nouveau calendar
        * UPDATE row (event_id + calendar_id)
        * n2g_moved++

      - Row présente, calendar_id == ownerEmail :
        * PATCH event (body complet reconstruit)
        * UPDATE row.last_synced_at et last_edited_at
        * n2g_updated++
```

### 8.6 Direction G→N (passe 2 du mode incremental)

```
Si GOOGLE_WATCH_EMAILS est vide : skip complètement cette passe.

Pour chaque email dans GOOGLE_WATCH_EMAILS :

  1. Récupérer google_sync_tokens.sync_token pour cet email (peut être null la 1ère fois)

  2. Appeler events.list :
     - params : singleEvents=true, showDeleted=true, maxResults=2500
     - si syncToken existe : passer syncToken=<token>
     - sinon : full list (attention : pas de syncToken + timeMin récent pour éviter charger 10 ans d'historique)
       → 1ère fois : timeMin = now - 30 jours, timeMax = now + 365 jours, pas de syncToken
       → On stocke nextSyncToken en fin de pagination pour les runs suivants

  3. Si 410 Gone : le syncToken a expiré.
     → DELETE row de google_sync_tokens pour ce calendar
     → Reboucler (1 essai max) : reprendre en mode full list, re-stocker le nouveau syncToken

  4. Paginer toutes les pages, collecter les GoogleEventSummary + nextSyncToken final

  5. Pour chaque event récupéré :

     a. Si event.status == 'cancelled' :
        - Si row SQLite par google_event_id :
          * Archiver la page Notion (PATCH page archived:true) — on n'efface pas pour garder la trace
          * DELETE row SQLite
          * g2n_deleted++
        - Sinon : g2n_skipped++ (on ne savait pas, rien à faire)
        - continue

     b. Si event.notionPageId != null :
        - C'est un event créé depuis Notion → jamais ingéré en Notion
        - g2n_skipped++
        - continue

     c. Chercher row SQLite par google_event_id :

        - Row absente :
          * Tester le marqueur sur event.summary (§8.8)
          * Si ne matche pas → g2n_skipped++ ; continue
          * Résoudre email du calendar → user Notion (§8.4). Si introuvable → g2n_skipped++ ; log warn.
          * CREATE page Notion (title = strippé, date, owner)
          * **Immédiatement après** : PATCH event Google pour ajouter extendedProperties.private.notion_page_id = newPageId
            → cette action "scelle" le lien et empêche toute ré-ingestion future
          * INSERT row SQLite (source='google', notion_page_id=newPageId, google_event_id, calendar_id=email, google_updated_at=event.updated)
          * g2n_created++

        - Row présente :
          * Comparer event.updated avec row.google_updated_at
          * Si event.updated > row.google_updated_at → la modif vient de Google
            * PATCH page Notion (title, date)
            * UPDATE row.google_updated_at, row.last_synced_at
            * g2n_updated++
          * Sinon → g2n_skipped++ (pas de changement côté Google depuis notre dernière vue)

  6. UPSERT google_sync_tokens(email, nextSyncToken, now())
```

### 8.7 Mode `reconcile`

Inchangé par rapport à la v1 unidirectionnelle, mais étendu :

```
1. Full scan Notion : toutes pages de la DB avec Date is_not_empty. Ne garder que les champs nécessaires.

2. Set<notionPageId> = pages actuellement visibles (non hard-deleted côté Notion)

3. Pour chaque row SQLite dont pageId ∉ Set :
   - Si row.source == 'notion' :
     → Notion page hard-deleted → DELETE event Google (best-effort) → DELETE row
   - Si row.source == 'google' :
     → La page Notion mirror a été hard-deleted, mais l'event Google existe peut-être encore.
     → GET l'event via (calendar_id, event_id). Si présent et status != cancelled :
       → Recréer la page Notion (comme une nouvelle ingestion)
       → UPDATE row avec nouveau notion_page_id
     → Sinon (event aussi supprimé) : DELETE row

4. Pour chaque page visible : appliquer la logique §8.5 (rattrapage incohérences)

5. meta['last_reconcile'] = now()
```

La reconciliation ne refait **pas** un full scan Google — les syncTokens s'en chargent en continu.

### 8.8 Matching du marqueur d'ingestion

Règle : le titre est "matchant" si, après trim, il **commence par le keyword** (case-insensitive) suivi d'une limite de mot.

Regex de référence :
```
^\s*<KEYWORD>(\s+|\s*[:\-–—]\s*)(.+)$
```
avec `<KEYWORD>` échappé. Groupe 2 = nouveau titre (strippé). Flag `i`.

Exemples (keyword = `NOTION`) :
- `"NOTION: Call client"` → match → `"Call client"`
- `"NOTION Call client"` → match → `"Call client"`
- `"notion - bla"` → match → `"bla"`
- `"NOTIONEVENT: x"` → **pas de match** (pas de word boundary)
- `"Weekly NOTION meeting"` → **pas de match** (keyword pas en tête)
- `"NOTION"` seul → pas de match (pas de titre après)

Implémentation testée dans `tests/keyword-match.test.ts`.

### 8.9 Prévention de boucle — récapitulatif

| Scénario | Protection |
|---|---|
| Event créé par N→G est ré-ingéré en G→N | `extendedProperties.private.notion_page_id` posé à la création → skip en G→N (§8.6.b) |
| Tâche créée en G→N est re-push vers Google | Row SQLite insérée immédiatement avec `source='google'` → le N→G suivant la trouve liée, fait un PATCH no-op au pire |
| Titre modifié en G→N, repush vers Google avec marqueur qui fait re-matcher | Le match marqueur ne s'applique QUE si aucune row SQLite n'existe pour cet event_id (§8.6.c) |
| Notion déclenche un update qui retrigger G→N | `event.updated` (mtime Google) comparée à `row.google_updated_at` → update ignoré si pas de change réel côté Google (§8.6.c "Row présente") |

### 8.10 Suppressions

| Côté | Signal | Action |
|---|---|---|
| Notion : archivage manuel | `page.archived == true` ou Status ∈ archived values | Delete event Google, delete row |
| Notion : hard-delete | Absent du scan reconcile | `reconcile` → delete event, delete row |
| Google : delete event | `event.status == 'cancelled'` via syncToken | Archive page Notion (pas hard-delete), delete row |
| Google : perte de syncToken | 410 Gone | Full resync (une fois), re-stocker syncToken |

### 8.11 Gestion d'erreur

- Chaque élément (page ou event) dans son propre `try/catch`. Une erreur ne bloque pas les autres.
- Log `error` + incrémenter `sync_runs.errors`.
- HTTP 404/410 sur `DELETE event` : silencieux (objectif atteint).
- 429 Notion/Google : retry 1 fois après 2 s.
- Si >50% des éléments d'une passe échouent → marquer le run `failed` avec 5 premières erreurs en `error_detail`.

### 8.12 Rate limiting

- Notion : ~3 req/s. `sleep(50ms)` entre pages si batch >50.
- Google Calendar : 500 req/user/100s. À notre échelle, pas de throttling nécessaire.

### 8.13 Timezone (point critique)

- Date Notion `YYYY-MM-DD` → all-day. Date Notion avec `T` → daté.
- Events datés : toujours passer `timeZone: config.sync.timezone` dans `start` et `end`.
- All-day : `end.date` **exclusif**.
- G→N : convertir `dateTime` Google en ISO pour Notion. Si `timeZone` présent dans l'event Google, respecter.

---

## 9. API externes utilisées

### 9.1 Google OAuth — token exchange (inchangé)

```
JWT RS256, payload { iss, sub, scope, aud, iat, exp }
POST https://oauth2.googleapis.com/token
grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion={jwt}
→ { access_token, expires_in }
Cache par userEmail, refresh 5 min avant exp.
```

### 9.2 Google Calendar v3

| Méthode | Endpoint | Usage |
|---|---|---|
| List par notion_page_id | `GET /calendars/primary/events?privateExtendedProperty=notion_page_id={id}&maxResults=1` | Filet de sécurité N→G |
| List par syncToken | `GET /calendars/primary/events?syncToken={t}&singleEvents=true&showDeleted=true` | Incrémental G→N |
| List full | `GET /calendars/primary/events?timeMin={iso}&timeMax={iso}&singleEvents=true&showDeleted=true` | Seed du syncToken |
| Create | `POST /calendars/primary/events` | N→G création, G→N patch initial |
| Patch | `PATCH /calendars/primary/events/{eventId}` | Updates |
| Delete | `DELETE /calendars/primary/events/{eventId}` | Suppression (404/410 = OK) |

Pagination : `pageToken` + `nextPageToken`. Le `nextSyncToken` **n'apparaît que sur la dernière page**.

### 9.3 Notion API

| Méthode | Endpoint (SDK) | Usage |
|---|---|---|
| Query DB | `databases.query` | Incrémental (last_edited filter) et full scan |
| Get user list | `users.list` | Résoudre email → user (cacher en mémoire par run) |
| Create page | `pages.create` | G→N ingestion |
| Update page | `pages.update` | G→N update |
| Archive page | `pages.update` avec `archived: true` | G→N suppression |

### 9.4 Parsing propriétés Notion

```typescript
// Title
props[name].title.map(t => t.plain_text).join("")

// Date (read)
{
  start: props[name].date?.start ?? null,
  end: props[name].date?.end ?? null
}
// isAllDay = !start.includes("T")

// Date (write) — envoi vers Notion
{ date: { start: iso, end: iso|null, time_zone: tz|null } }
// time_zone uniquement si start contient "T"

// Person (prendre le premier si plusieurs)
props[name].people?.[0]?.person?.email

// Status / Select
props[name].status?.name ?? props[name].select?.name ?? null
```

### 9.5 Dockerfile (Railway)

```dockerfile
FROM denoland/deno:2.1.4

WORKDIR /app

COPY deno.json deno.lock* ./
COPY *.ts ./
COPY *.sql ./

RUN deno cache main.ts

VOLUME /data

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-ffi", "main.ts"]
```

Permissions : `--allow-net --allow-env --allow-read --allow-write --allow-ffi`.

---

## 10. Déploiement Railway

1. Push repo → connecter à Railway.
2. Créer un **Volume**, monté sur `/data` (min 1 GB).
3. Définir les env vars (§5).
4. Configurer **Cron Schedule** : `*/5 * * * *`.
5. Premier déploiement → regarder les logs.

**Premier run** :
- Les calendriers de `GOOGLE_WATCH_EMAILS` seront seeded (timeMin = now - 30j, timeMax = now + 365j). Sur un gros calendrier ça peut durer. Considérer un run manuel initial hors cron.

**Backup volume** : snapshot manuel via dashboard Railway. Automatisation hors scope v1.

---

## 11. Logs

Format ligne-par-ligne, préfixé du niveau et timestamp. Exemples :

```
[2026-04-20T09:15:03.421Z] [info] run_start mode=incremental
[2026-04-20T09:15:03.892Z] [info] n2g_query found=3 since=2026-04-20T09:10:00.000Z
[2026-04-20T09:15:04.102Z] [info] n2g_event_created page=abc123 user=alice@co.com title="Call client"
[2026-04-20T09:15:04.400Z] [info] g2n_query_start email=alice@co.com has_sync_token=true
[2026-04-20T09:15:04.700Z] [info] g2n_page_created event=xyz789 email=alice@co.com title="Q3 planning"
[2026-04-20T09:15:04.900Z] [info] g2n_event_sealed event=xyz789 notion_page=def456
[2026-04-20T09:15:05.100Z] [warn] g2n_owner_not_found email=ext@other.com event=abc123
[2026-04-20T09:15:05.300Z] [info] run_end mode=incremental duration_ms=1880 n2g_created=1 n2g_updated=2 g2n_created=1 g2n_skipped=4 errors=0
```

---

## 12. Tests

- `keyword-match.test.ts` : regex de match + strip (6+ cas, dont les exemples §8.8)
- `calendar-body.test.ts` : Notion date → Google body (all-day avec/sans end, daté avec/sans end, TZ)
- `notion.test.ts` : parsing pages Notion mockées (title vide, owner multi-personnes, status absent, archivée)
- `sync-n2g.test.ts` : arbre de décision (SQLite `:memory:`, fetch mocké)
- `sync-g2n.test.ts` : ingestion + update + cancellation + event déjà lié (skip) + seed syncToken + 410

`deno test --allow-all`

---

## 13. Hors scope v1

- Événements récurrents (RRULE) — côté N→G on crée un event simple par page, pas de série. Côté G→N, `singleEvents=true` éclate les occurrences — mais les modifs d'une occurrence individuelle vs série ne sont pas gérées finement.
- Attendees / invités Google Calendar
- Multi-calendriers par utilisateur (on tape toujours `primary`)
- Rappels/notifications configurables
- UI admin / dashboard
- Webhooks Notion (inexistants pour databases)
- Backup auto du volume
- Migration schéma DB versionnée
- Métriques externes (Prometheus / OTel)
- Contenu du corps de page Notion en G→N (on crée juste les propriétés)

---

## 14. Critères d'acceptation

### Direction N→G

- ✅ Ajouter une tâche datée dans Notion → event apparaît dans GCal de l'owner au run suivant
- ✅ Changer titre/date → event mis à jour
- ✅ Changer owner → event déplacé (ancien supprimé, nouveau créé)
- ✅ Archiver la page (corbeille) → event supprimé
- ✅ Status → valeur archivée → event supprimé
- ✅ Tâche sans owner ou sans date → skip, pas d'erreur
- ✅ Kill -9 en plein run → run suivant reprend proprement

### Direction G→N

- ✅ Créer dans GCal (user watched) un event `"NOTION: X"` → page Notion `X` créée avec owner = user
- ✅ Event sans préfixe `NOTION` → ignoré
- ✅ Event avec préfixe mais sur calendrier non-watched → ignoré
- ✅ Event déjà créé par N→G (porte `notion_page_id`) → jamais ré-ingéré même si titre contient `NOTION`
- ✅ Modifier titre/date côté GCal sur event lié → page Notion mise à jour
- ✅ Supprimer event côté GCal → page Notion archivée
- ✅ syncToken expiré (410) → full resync automatique, pas de doublons (les events sont retrouvés via google_event_id)

### Reconcile

- ✅ Hard-delete d'une page Notion `source='notion'` → event GCal supprimé
- ✅ Hard-delete d'une page Notion `source='google'` alors que event GCal existe → page Notion recréée
- ✅ Event GCal supprimé manuellement (pas via cancel) et row SQLite restante → recréation au prochain incremental (filet via privateExtendedProperty)

---

## 15. Commandes utiles

```bash
# Installation
curl -fsSL https://deno.land/install.sh | sh

# Dev
deno task dev

# Run incremental
deno task start

# Reconcile forcé
deno run --allow-all main.ts reconcile

# Tests
deno test --allow-all

# Inspection DB
sqlite3 /data/sync.db "SELECT * FROM synced_tasks LIMIT 10;"
sqlite3 /data/sync.db "SELECT * FROM sync_runs ORDER BY id DESC LIMIT 5;"
sqlite3 /data/sync.db "SELECT * FROM google_sync_tokens;"
```

---

## 16. Ordre d'implémentation

1. `deno.json` + `config.ts` + `logger.ts` + `.gitignore` → bootstrap
2. `db.ts` + `migrations.sql` → init SQLite, helpers (get/upsert/delete synced_tasks + google_sync_tokens + sync_runs + meta)
3. `google-auth.ts` → JWT RS256 + cache token + test manuel via un `calendar.events.list`
4. `calendar.ts` → wrapper : list (full + syncToken), create, patch, delete, findByNotionId
5. `notion.ts` → query DB, parse pages, create/update/archive page, users.list
6. `sync-n2g.ts` → direction Notion → Google (logique §8.5) + tests
7. `sync-g2n.ts` → direction Google → Notion (logique §8.6) + tests (incluant scénario 410 → full resync)
8. `sync.ts` → orchestration : init, récupère dernier run OK, lance N→G puis G→N, reconcile si dû, clôture sync_runs
9. `main.ts` → dispatch mode + init DB + run + exit propre
10. Reconcile (logique §8.7) — peut se faire en parallèle de l'étape 8
11. Dockerfile + README de déploiement + `.env.example`

Chaque étape validée par l'utilisateur avant de passer à la suivante.
