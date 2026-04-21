# Contexte projet — règles pour Claude Code

Tu travailles sur un projet dont la spec complète est dans `SPEC.md` à la racine. **Cette spec fait foi.** Si ce fichier et `SPEC.md` se contredisent, `SPEC.md` gagne. Si tu penses qu'une partie de la spec est ambiguë ou manque, **tu demandes avant d'improviser**.

Le projet est un sync **bidirectionnel** Notion ↔ Google Calendar. Le bidirectionnel est la principale source de complexité — lis la section 8 de `SPEC.md` en entier avant toute ligne de code.

---

## Stack (non négociable)

- **Runtime** : Deno 2.x exclusivement. Pas de Node, pas de Bun.
- **Langage** : TypeScript avec `"strict": true` dans `deno.json`.
- **Dépendances autorisées** :
  - `npm:@notionhq/client@^2.2.15` — SDK officiel Notion
  - `jsr:@db/sqlite@^0.12` — SQLite natif Deno
- **Aucune autre lib.** Pas de `googleapis`, pas de `google-auth-library`, pas de `zod`, pas de `dayjs`, pas d'ORM, pas de framework HTTP, pas de logger externe.
- **Auth Google** : implémentée à la main avec Web Crypto API. JWT RS256 + token exchange via `fetch`.

Si tu penses avoir besoin d'une lib supplémentaire, **tu demandes d'abord**. Tu ne l'ajoutes pas toi-même.

---

## Règles de code

- Fichiers métier en **racine** du repo (pas de `src/`), sauf `tests/` qui regroupe les tests.
- Deux fichiers séparés pour les deux directions : `sync-n2g.ts` et `sync-g2n.ts`. Orchestration dans `sync.ts`. Ne pas les fusionner.
- Une fonction = une responsabilité. Style fonctionnel/déclaratif, early returns.
- Pas de classes sauf cas justifié (helper DB).
- Typage explicite sur les exports publics. `any` interdit sauf justification en commentaire (SDK Notion peut exiger un cast local ponctuel).
- **Pas de commentaires qui paraphrasent le code.** Commentaires réservés aux *pourquoi* non évidents.
- Logs via le module `logger.ts` du projet, jamais `console.log` direct.
- Toute opération réseau ou SQL dans un `try/catch` avec contexte utile (pageId, eventId, calendarId, userEmail…).

---

## Workflow obligatoire

1. Tu suis l'ordre d'implémentation de la **section 16 de SPEC.md**.
2. À la fin de chaque étape, tu **t'arrêtes** et tu postes :
   - Les fichiers créés/modifiés
   - Un résumé concis de ce qui est fait
   - Les tests qui passent (sortie `deno test`)
3. Tu attends ma **validation explicite** avant de passer à l'étape suivante.
4. Tu n'anticipes pas sur les étapes futures (pas de scaffolding prématuré).
5. Commits : un commit par étape validée, conventional commits anglais court (`feat:`, `chore:`, `test:`, `fix:`, `docs:`). Corps en français si utile.

---

## Tests

- Tests unitaires écrits **en même temps** que le code, pas après.
- Une étape sans ses tests n'est pas terminée.
- Deno test runner uniquement (`deno test --allow-all`).
- Sync : fetch mocké + SQLite `:memory:`.
- Obligatoires : `keyword-match` (tous les cas §8.8), `calendar-body` (all-day vs daté), scénario `g2n` complet (ingestion initiale + update + cancellation + event déjà lié + seed syncToken + 410).

---

## Pièges connus à NE PAS oublier

### Stack & infra

- **PEM private key & Railway** : Railway stocke les `\n` comme littéraux. `config.ts` fait `.replace(/\\n/g, "\n")` avant import PKCS8.
- **Scope Google exact** : `https://www.googleapis.com/auth/calendar`. Tout autre scope → JWT refusé (DWD whitelist stricte).
- **Permissions Deno** : toujours `--allow-ffi` (requis par `@db/sqlite`).
- **Notion capability emails** : si les emails Person reviennent `null`, l'intégration n'a pas la capability "Read user information including email addresses". **Ne pas modifier le code** — signaler à l'utilisateur.

### Dates & timezones

- **All-day Google** : `end.date` **exclusif**. Event du 5 nov seul → `start.date = "2025-11-05"`, `end.date = "2025-11-06"`.
- **Events datés Google** : toujours passer `timeZone: config.sync.timezone` dans `start` et `end`, même si `dateTime` a un offset.
- **Notion date write** : utiliser `time_zone: null` pour all-day, `time_zone: tz` pour daté.

### Bidirectionnel — prévention de boucle

- **Sceller l'event après ingestion G→N** : après avoir créé la page Notion depuis un event Google, il faut **immédiatement** faire un `PATCH` de l'event pour y poser `extendedProperties.private.notion_page_id`. Sans ce scellement, le prochain run pourrait ré-ingérer. Implémente cet ordre strict : create Notion page → patch Google event → insert SQLite row.
- **Skip en G→N si `extendedProperties.private.notion_page_id` présent** : c'est un event créé par N→G, jamais ingéré en Notion quel que soit son titre.
- **Marqueur de keyword uniquement à l'ingestion initiale** : si une row SQLite existe déjà pour le `google_event_id`, on suit l'event quel que soit son titre (le keyword est un déclencheur, pas une condition permanente).
- **Détection des vraies modifs Google** : comparer `event.updated` avec `row.google_updated_at` pour éviter de repasser dans Notion une modif qui vient en réalité de Notion.

### Suppressions

- **404/410 sur `DELETE event`** : pas une erreur. Log `debug`, pas plus.
- **410 sur `events.list` avec syncToken** : le token a expiré. DELETE la row `google_sync_tokens` et retry en full list une fois. Ne pas logger `error`, c'est un cas attendu.
- **Archivage Notion côté G→N** : quand un event est cancelled, on **archive** la page Notion (`archived: true`), on ne la hard-delete pas. Ça laisse une trace récupérable.

### Ordre des passes

- Le mode incremental fait **N→G puis G→N**, dans cet ordre. Ne pas inverser.
- Le mode incremental peut déclencher un reconcile interne si `RECONCILE_INTERVAL_HOURS` écoulé — prévoir cet appel à la fin du run.

---

## Ce que tu ne fais PAS

- Tu ne modifies pas le schéma de la base Notion depuis le code (aucune création de propriété).
- Tu n'implémentes rien qui figure dans la section 13 (hors scope) de `SPEC.md`.
- Tu ne refactores pas "pour mieux faire" tant que le v1 n'est pas livré et validé.
- Tu ne fusionnes pas `sync-n2g.ts` et `sync-g2n.ts` "pour factoriser".
- Tu ne commits **jamais** : `.env`, JSON de clé service account, fichiers `.db`, `node_modules/`. Le `.gitignore` doit être en place dès l'étape 1.
- Tu ne crées pas de serveur HTTP. Le projet est un script CLI qui s'exécute et exit.

---

## Quand tu bloques ou hésites

Si un choix n'est pas couvert par `SPEC.md` ou ce fichier : **tu poses la question.** Tu ne tranches pas à ma place.

Format attendu :
1. Quelle décision est à prendre
2. Les 2-3 options que tu vois, avec leurs trade-offs
3. Ta préférence motivée en une phrase

---

## Communication

- Réponses en français.
- Code et identifiants en anglais (noms de fichiers, variables, fonctions, commits).
- Pas de flatterie (« Excellente idée ! »). Droit au but.
- Si une demande te paraît problématique, tu le dis avant d'exécuter.
