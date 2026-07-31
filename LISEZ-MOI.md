# Biblio-ninoush — version installable (PWA)

Ce dossier contient l'application en **Progressive Web App** : une fois en ligne,
elle s'installe sur l'écran d'accueil du téléphone et fonctionne hors-ligne.

## Contenu du dossier

    biblio-pwa/
    ├── index.html                    ← l'application
    ├── manifest.json                 ← nom, icône, couleurs
    ├── sw.js                         ← cache hors-ligne (service worker)
    └── icons/                        ← icônes de l'appli
        ├── icon-192.png
        ├── icon-512.png
        ├── icon-maskable-512.png
        ├── apple-touch-icon.png
        └── favicon-32.png

**Gardez ces fichiers ensemble, avec cette structure.** Le dossier `icons`
doit rester à côté de `index.html`.

## Point important

Une PWA a besoin d'une adresse **https://** pour s'installer et pour le service
worker : elle ne peut PAS fonctionner en double-clic (`file://`). Il faut donc
l'héberger. C'est gratuit et rapide.

## Mise en ligne (au choix)

### Option A — Netlify Drop (le plus simple, ~1 minute)
1. Allez sur https://app.netlify.com/drop
2. Glissez-déposez le dossier `biblio-pwa` entier sur la page.
3. Vous obtenez une adresse `https://…netlify.app` — ouvrez-la sur le téléphone.

### Option B — GitHub Pages
1. Créez un dépôt GitHub, déposez-y le contenu du dossier.
2. Settings → Pages → activez la publication depuis la branche `main`.
3. L'adresse `https://votre-nom.github.io/…` est prête après une minute.

## Installer sur le téléphone

- **Android / Chrome** : ouvrez l'adresse → un bouton « Installer l'application »
  apparaît (dans l'appli, menu ⋯, ou proposé par le navigateur).
- **iPhone / Safari** : bouton Partager → « Sur l'écran d'accueil ».

L'icône du livre doré s'ajoute à l'écran d'accueil ; au lancement, l'appli
s'ouvre en plein écran, sans barre de navigateur.

## Ce qui marche hors-ligne

Après la première ouverture en ligne : l'appli, vos livres et les couvertures
déjà affichées restent accessibles sans réseau. La recherche de nouveaux livres
et le scan (qui interrogent internet) nécessitent une connexion.

## Mettre à jour l'appli plus tard

Si vous modifiez `index.html`, ouvrez `sw.js` et changez la ligne
`const APP_VERSION = 'v1';` en `'v2'`, etc. Cela force les téléphones à
récupérer la nouvelle version au lieu de servir l'ancienne depuis le cache.
