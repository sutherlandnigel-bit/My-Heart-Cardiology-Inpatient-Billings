# MHC Inpatient Billing — PWA (beta)

This is a Progressive Web App: a normal website that can be "installed" to a phone's
home screen and behaves like an app (own icon, full-screen, works offline after first load).

## What changed from the earlier prototype

- **Real persistence.** Entries and photos are now saved in the browser's IndexedDB
  storage, not just in memory. Closing the app, restarting the phone, etc. no longer
  loses your data — only uninstalling the app / clearing site data does.
- **Offline support.** A service worker caches the app and the PDF library on first
  load, so it keeps working with no signal (e.g. hospital basements).
- **Photos are downscaled** to a sensible size before saving, so a full day's worth of
  captures doesn't quietly eat your phone's storage.
- Everything else (photo capture, MBS entry, PDF export, bulk actions) is unchanged.

Nothing here uploads anything anywhere — all storage and processing is on-device.

## You need real hosting for a PWA to install properly

iOS and Android both require a PWA to be served over **HTTPS** (or `localhost`) before
"Add to Home Screen" will treat it as an installable app rather than just a bookmark.
Opening `index.html` straight from a file on your phone won't give you the full
install/offline experience — pick one of the options below.

### Fastest option for beta testing: Netlify Drop (no account needed for a quick test)

1. Go to https://app.netlify.com/drop in a browser
2. Drag the whole unzipped `mhc-pwa` folder onto the page
3. Netlify gives you a live HTTPS URL in a few seconds — share that URL with your beta testers

### More permanent option: GitHub Pages

1. Create a new GitHub repo and upload the contents of this folder
2. Repo Settings → Pages → set source to the `main` branch, root folder
3. GitHub gives you a URL like `https://yourname.github.io/mhc-billing/`

### Testing on your own local network first

```
cd mhc-pwa
python3 -m http.server 8000
```
Then visit `http://<your-computer's-LAN-IP>:8000` from your phone (same wifi network).
Note: iOS may not offer a full "install" prompt over plain HTTP on a LAN IP — this is
mainly useful for checking the app works before you put it on real HTTPS hosting.

## Installing on iPhone once it's hosted somewhere with HTTPS

1. Open the URL in **Safari** (must be Safari, not Chrome, for the install option to appear)
2. Tap the Share icon → **Add to Home Screen**
3. It now opens full-screen from your home screen icon, like a normal app

## Installing on Android

1. Open the URL in Chrome
2. Chrome will usually prompt "Add to Home screen" automatically, or use the ⋮ menu → **Add to Home screen**

## Updating the app later

Bump `CACHE_VERSION` in `sw.js` (e.g. `mhc-billing-v2`) whenever you change any file and
re-upload. That forces installed copies to fetch the new version instead of serving the
old cached one.

## Known limitations of this beta

- Single clinician per device/install — the clinician name in Settings is global, not
  per-user, so if two clinicians share one device/phone it'll need switching manually.
- No cross-device sync — an entry marked "Billed" only updates on the device it was
  marked on. Notifying a clinician when admin completes billing on a *different* device
  still needs a small backend service; this beta doesn't include one.
- This is a beta for internal testing — confirm it meets MHC's privacy and MBS billing
  policies before using it on real patients.
