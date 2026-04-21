# Prompt d'amorçage pour Claude Code

> Colle le texte ci-dessous comme premier message dans Claude Code, après avoir placé `SPEC.md` et `CLAUDE.md` à la racine du repo (vide par ailleurs).

---

## Message à coller

```
Tu vas implémenter le projet décrit dans @SPEC.md en suivant les règles de @CLAUDE.md.

Avant d'écrire une seule ligne de code, fais ceci dans l'ordre :

1. Lis intégralement SPEC.md et CLAUDE.md.

2. Réponds-moi avec :
   a) Un résumé en 5-8 lignes de ce que fait le projet, pour qui, et quelle est l'archi globale.
   b) Les 3 points de la spec qui te paraissent les plus risqués ou ambigus (et pour chacun, ta proposition de lecture).
   c) Les questions bloquantes que tu as avant de commencer — ou "aucune" si tu n'en as pas.

3. Attends ma validation.

4. Une fois validé, attaque l'étape 1 de la section 16 de SPEC.md, et SEULEMENT cette étape. À la fin :
   - Liste les fichiers créés
   - Lance les tests si pertinent à ce stade
   - Résume en 2-3 phrases
   - Attends ma validation avant de passer à l'étape 2

Ne scaffolde pas les fichiers des étapes suivantes. Ne prends pas d'initiative hors scope. Si tu as un doute : tu demandes.

Langue : français pour la conversation, anglais pour le code et les commits.
```

---

## Pourquoi ce prompt est structuré comme ça

- **Point 1 (lecture complète)** : force Claude Code à charger les deux documents en contexte avant toute action. Évite l'effet « je lis les premières lignes et j'extrapole ».
- **Point 2a (résumé)** : permet de vérifier rapidement qu'il a compris. Si le résumé est à côté, tu rectifies tout de suite avant qu'il écrive 500 lignes dans la mauvaise direction.
- **Point 2b (points risqués)** : révèle sa lecture de la spec. Un bon Claude Code va pointer la timezone, le DWD, la gestion des suppressions. Un Claude Code qui dit "rien de risqué" n'a pas bien lu.
- **Point 2c (questions bloquantes)** : ouvre explicitement la porte aux questions. Sans ça, Claude Code a tendance à combler les ambiguïtés par ses préférences.
- **Point 3 (validation)** : le checkpoint. Tu réponds "OK, vas-y" ou tu corriges avant qu'il commence.
- **Point 4 (une étape à la fois)** : empêche le scaffolding massif. Chaque étape est validée avant la suivante.

---

## Ce à quoi tu dois t'attendre au retour

Une bonne première réponse ressemblera à :

> **Résumé** : Script CLI Deno qui synchronise les tâches d'une base Notion vers les Google Calendars des owners respectifs, dans un Workspace commun. Un cron Railway l'exécute toutes les 5 min. État persisté en SQLite sur un volume Railway. Mode `reconcile` 1×/jour pour rattraper les incohérences.
>
> **Points risqués** :
> 1. Gestion des timezones et des all-day vs datés (section 8.8) — la convention `end.date` exclusive de Google est un piège classique.
> 2. Auth Google via JWT RS256 en Web Crypto natif (section 9.1) — pas de lib, il faut bien gérer le format PKCS8 et la re-conversion des `\n`.
> 3. Détection des suppressions (section 8.5) — trois cas à distinguer : archivage Notion, status "archived", hard-delete (reconcile only).
>
> **Questions** : aucune, la spec est suffisamment détaillée.

Si la réponse ne ressemble pas à ça — par exemple s'il attaque directement le code, ou si les points risqués sont creux — reprends la main, rappelle les consignes, et relance.

---

## Relances utiles pendant le projet

Si Claude Code commence à déborder :

- *« Stop. Tu es sorti du scope de l'étape N. Reviens à SPEC.md section 16 étape N uniquement. »*
- *« Tu as ajouté la dépendance X. Retire-la. CLAUDE.md interdit les deps non listées. »*
- *« Tu ne m'as pas attendu pour passer à l'étape suivante. Reverte le commit et montre-moi d'abord l'étape précédente. »*

Si Claude Code bloque ou boucle :

- *« Explique-moi ce que tu essaies de faire et pourquoi tu coinces. On va réfléchir ensemble avant de recoder. »*
- *« Montre-moi le dernier état du fichier X et l'erreur exacte. »*

---

## Bonus — commande terminal utile

Une fois le repo initialisé, pour un aperçu rapide de l'état du projet :

```bash
git log --oneline -20 && echo "---" && ls -la && echo "---" && cat deno.json
```

À lancer toi-même (pas demander à Claude Code) pour garder un œil sur l'avancement.
