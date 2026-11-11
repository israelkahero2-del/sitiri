# Sitiri

Sitiri swaps names, addresses and numbers in a Word document, PDF or scan for placeholders before you share it, and puts them back afterwards with a key that you keep.

It runs entirely in the browser. Documents and keys are never uploaded.

## Files

- `index.html`: the front page.
- `tool.html`: the tool itself (redact and restore).
- `terms.html`: terms of use and privacy.
- `sitiri.css`: shared styles.
- `convert.js`: reads PDFs, scans and photos and turns them into text, in the browser.
- `vendor/`: the open-source PDF reader and scan reader, stored with the site.
- `sw.js` and `manifest.webmanifest`: let the site open offline and be installed.
- `fonts/` and `icons/`: typefaces and icons, stored with the site.
- `LICENSES.txt`: notices for the open-source components.

## Running it

Open the published site, or serve this folder with any static web server. No build step and no server-side code.

## Rights

Copyright 2026 [YOUR NAME]. All rights reserved, except for the open-source components listed in `LICENSES.txt`.
