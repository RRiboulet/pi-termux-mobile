# Path 3: Termux-native, no APK — Architecture & Plan

> **Status:** Planning phase. This document defines the architecture for
> removing the Android APK entirely and running the bridge directly in
> Termux, with the phone as the server host and any browser as the client.
>
> **Decision:** Path 3 (from `docs/plan-revision.md` §0 and the
> `ANALYSE.md` "Weg A" evaluation). The APK, the foreground service,
> the WebView host, and the RuntimeInstaller are all removed. The bridge
> runs as a normal Termux process.

---

## 1. What changes, and what does not

### 1.1 What stays (the 90% that is already ready)

| Component | Status | Notes |
|---|---|---|
| `runtime/server.mjs` | Ready | HTTP+SSE bridge, auth, access modes, static serving |
| `runtime/common.mjs` | Ready | Harness setup, credential store, session registry |
| `runtime/gate.mjs` | Ready | Install gate for agent-written extensions |
| `runtime/models-config.mjs` | Ready | Reader for `~/.pi/agent/models.json` |
| `runtime/sse.mjs`, `watermark.mjs` | Ready | SSE backpressure and frame watermarking |
| `runtime/public/` (client) | Ready | Preact+htm, no build step, works in any browser |
| Auth system | Ready | Tokens, cookies, pairing codes, device registry |
| Access modes | Ready | `local`, `tailscale`, `lan` with Host validation |
| SSE stream + snapshots | Ready | Watermark, reconnect, gapped handling |
| Install gate | Ready | Hash-verified, user-confirmed extension installs |
| Backup/restore | Ready | Tar archive with manifest |
| Tests | Ready | 16 test files, `node scripts/run-tests.mjs` |

### 1.2 What is removed

| Component | Why | Replacement |
|---|---|---|
| `android/` (entire directory) | No more native host | Termux itself is the host |
| `PiService.java` | Foreground service, wake lock, process supervision | Termux foreground service + `termux-wake-lock` |
| `MainActivity.java` | WebView host, waits for port file | Browser navigates to the URL directly |
| `RuntimeInstaller.java` | Extracts Termux rootfs from APK assets | `pkg install` provides everything |
| `port`/`token` files | Bridge writes these for Android to read | Not needed — URL is known or configured |
| `status.json` | Bridge writes for Android notification | Optional: Termux:API notification or skip |
| Prefix rewrite (`/data/data/com.termux` → `app.pidabl`) | APK package id must match Termux prefix length | Not needed — Termux uses its own prefix |
| `termux-exec` LD_PRELOAD hook | Android app-home exec ban workaround | Not needed — Termux handles this |
| Phantom process killer workaround | Android 12+ kills child processes | Not needed on Termux (it's the system shell) |
| `prepare-runtime.py` / `package-rootfs.ts` | Package rootfs into APK assets | Not needed — `pkg install` |
| `install-wifi.sh`, `pair-install.sh` | Wireless APK install | Not needed — Termux install is standard |

### 1.3 What is added

| Component | Purpose |
|---|---|
| `scripts/setup-termux.sh` | One-command Termux bootstrap: install deps, clone repo, start bridge |
| `scripts/termux-start.sh` | Start the bridge with proper env, wake lock, and supervision |
| `scripts/termux-stop.sh` | Graceful shutdown |
| `scripts/termux-boot.sh` | Termux:Boot auto-start script |
| PWA manifest (`runtime/public/manifest.json`) | "Add to Home Screen" on any device |
| Service worker (`runtime/public/sw.js`) | Offline shell caching |
| `docs/termux-setup.md` | User-facing setup guide |

---

## 2. Architecture

### 2.1 Process model

```
Termux (foreground app or background service)
│
├── node runtime/server.mjs  (the bridge)
│   ├── HTTP server on :8787 (or configured port)
│   ├── SSE stream for live updates
│   ├── Pi Durable Harness (SQLite-backed)
│   ├── Agent (bash, git, rg, etc. via NodeExecutionEnv)
│   └── Static file server (runtime/public/)
│
├── termux-wake-lock  (keeps CPU awake)
│
└── Optional: watchdog loop (restart bridge on crash)
```

**Process supervision** is provided by Termux itself:
- Termux runs as a foreground service when the app is open
- `termux-wake-lock` acquires a PARTIAL_WAKE_LOCK
- Termux:Boot can auto-start the bridge on device reboot
- A simple watchdog script can restart the bridge if it crashes

There is no Android foreground service, no wake lock Java code, no process supervision Java code. Termux handles all of this.

### 2.2 Network model

```
Phone (Termux bridge on :8787)
│
├── localhost:8787  ← browser on the phone
├── 100.x.x.x:8787  ← Tailscale peers (if PI_ACCESS=tailscale)
└── 192.168.x.x:8787  ← LAN devices (if PI_ACCESS=lan)
```

The bridge already supports all three access modes. No code changes needed.

**For remote access (not on the same network):**
- Tailscale: join the phone to your tailnet. Access via Tailscale IP or MagicDNS.
- ngrok: `ngrok http 8787` on the phone. Access via ngrok URL.
- Cloudflare Tunnel: `cloudflared tunnel` on the phone.

### 2.3 Auth model (unchanged)

The auth system works as-is:
1. Bootstrap token (generated on first run, stored in `~/.pi-mobile/token`)
2. Device pairing (one-time codes, 15 min TTL)
3. HttpOnly cookies (SameSite=Strict)
4. Token rotation (signs out all other devices)

For Termux, the bootstrap token is printed to the console on first run.
The user copies it into a browser on any device, or uses the pairing flow.

### 2.4 Data model (unchanged)

All data lives in `$HOME/.pi-mobile/`:
- `harness.sqlite` — sessions, transcripts, usage, tasks
- `extensions.json` — installed extensions, proposals, refusals
- `devices.json` — paired devices (SHA-256 of tokens only)
- `access.json` — access mode and hostnames
- `backups/` — tar archives of the database
- `log/` — bridge and service logs

For Termux, `$HOME` is `/data/data/com.termux/files/home` (or wherever Termux sets it).

### 2.5 Client model

The client is a **PWA** served by the bridge:

```
Browser (any device)
├── Loads https://phone:8787 (or ngrok URL)
├── Registers service worker (offline shell)
├── "Add to Home Screen" (PWA install)
├── SSE stream for live updates
├── Cookie-based auth (HttpOnly, SameSite=Strict)
└── All UI in runtime/public/ (Preact+htm, no build step)
```

The client already works in any browser. The PWA additions are:
- `manifest.json` — app name, icons, display mode, theme color
- `sw.js` — cache the app shell, serve offline
- Service worker registration in `app.js`

---

## 3. What needs to change in the codebase

### 3.1 Remove (delete)

- `android/` — entire directory
- `scripts/prepare-runtime.py` — no APK assets
- `scripts/package-rootfs.ts` — no rootfs extraction
- `scripts/install-wifi.sh`, `scripts/pair-install.sh` — no APK install
- `scripts/device-smoke.sh` — no device install (replace with bridge smoke test)
- `docs/adb-wireless-install.md` — no adb
- `docs/device-verification.md` — replace with Termux verification

### 3.2 Modify

- `runtime/server.mjs`:
  - Remove port/token file writing (or make optional)
  - Remove status.json writing (or make optional, use Termux:API)
  - Keep everything else as-is
- `runtime/public/index.html`:
  - Add `<link rel="manifest" href="manifest.json">`
  - Add service worker registration
- `runtime/public/app.js`:
  - Add service worker registration
  - Remove WebView-specific assumptions (mostly already fine)
- `package.json` (root):
  - Update scripts for Termux
  - Remove Android-specific test references
- `README.md`:
  - Rewrite for Termux setup

### 3.3 Add

- `runtime/public/manifest.json` — PWA manifest
- `runtime/public/sw.js` — service worker
- `runtime/public/icons/` — PWA icons (192x192, 512x512)
- `scripts/setup-termux.sh` — bootstrap script
- `scripts/termux-start.sh` — start script with wake lock
- `scripts/termux-stop.sh` — stop script
- `scripts/termux-boot.sh` — Termux:Boot auto-start
- `docs/termux-setup.md` — setup guide

### 3.4 Keep as-is

- All of `runtime/` except the modifications above
- All of `test/` (they run on Termux too)
- `docs/` (update references, keep content)

---

## 4. Setup flow (user experience)

### 4.1 First-time setup

```bash
# 1. Install Termux from F-Droid (not Play Store)
# 2. Open Termux, then:
pkg update && pkg upgrade
pkg install nodejs git ripgrep termux-api termux-tools

# 3. Clone the repo
git clone https://github.com/<user>/pi-termux-mobile.git ~/pi-mobile
cd ~/pi-mobile

# 4. Install runtime dependencies
cd runtime && npm ci --omit=dev --omit=optional --ignore-scripts && cd ..

# 5. Start the bridge
bash scripts/termux-start.sh
```

The bridge prints:
```
pi-mobile durable bridge on 127.0.0.1:8787
bootstrap token: <random-token>
```

### 4.2 First access

1. On the phone: open a browser, go to `http://127.0.0.1:8787/?token=<token>`
2. The token is exchanged for a cookie. The token is cleared from the URL.
3. You're in. The UI loads.

### 4.3 Pairing a second device

1. On the phone (already signed in): Menu → Sign in another device
2. It shows a URL and a code
3. On the laptop: open the URL, enter the code
4. The laptop gets its own cookie

### 4.4 Remote access (Tailscale)

1. Install Tailscale on the phone and the laptop
2. Join both to the same tailnet
3. On the phone: Menu → Access → Tailscale (or `PI_ACCESS=tailscale`)
4. Restart the bridge
5. On the laptop: open `http://<phone-tailscale-ip>:8787` or `http://<phone-magicdns-name>:8787`

### 4.5 Auto-start on reboot

1. Install Termux:Boot from F-Droid
2. Copy `scripts/termux-boot.sh` to `~/.termux/boot/`
3. On reboot, Termux starts and launches the bridge

### 4.6 Wake lock

```bash
termux-wake-lock  # prevents CPU sleep
```

This is called by `scripts/termux-start.sh`. The user must also exempt Termux
from battery optimization in Android settings.

---

## 5. Process supervision

### 5.1 Without watchdog (simple)

Termux keeps the bridge alive as long as Termux is running. If the bridge
crashes, Termux shows a notification. The user restarts manually.

### 5.2 With watchdog (recommended)

A simple loop in `scripts/termux-start.sh`:

```bash
#!/bin/bash
cd ~/pi-mobile
termux-wake-lock
while true; do
  node runtime/server.mjs
  echo "bridge exited, restarting in 5s..."
  sleep 5
done
```

This restarts the bridge automatically on crash. The harness survives because
it's SQLite-backed.

### 5.3 Termux:Boot

```bash
#!/bin/bash
# ~/.termux/boot/pi-mobile.sh
cd ~/pi-mobile
nohup bash scripts/termux-start.sh > ~/.pi-mobile/boot.log 2>&1 &
```

---

## 6. PWA additions

### 6.1 manifest.json

```json
{
  "name": "pi mobile",
  "short_name": "pi",
  "description": "Phone-native durable coding agent",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0A0A0A",
  "theme_color": "#0A0A0A",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

### 6.2 Service worker (sw.js)

Cache the app shell (HTML, CSS, JS, vendor) for offline loading. API calls
and SSE streams always go to the network.

```javascript
const CACHE_NAME = 'pi-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/vendor/preact.js',
  '/vendor/htm.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API and SSE always go to network
  if (url.pathname.startsWith('/api/')) return;
  // App shell: cache-first, network fallback
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
```

### 6.3 Service worker registration in app.js

Add to the boot section of `app.js`:

```javascript
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
```

---

## 7. What stays the same (no changes needed)

- **Bridge protocol**: HTTP+SSE, same endpoints, same shapes
- **Auth**: tokens, cookies, pairing, device registry
- **Access modes**: local, tailscale, lan
- **Client code**: Preact+htm, works in any browser
- **Harness**: SQLite-backed, survives process death
- **Extensions**: install gate, hash verification, hot install
- **Models config**: `~/.pi/agent/models.json`
- **OAuth**: provider flows, device codes, browser redirects
- **Backup/restore**: tar archives with manifest
- **Tests**: all 16 test files run on Termux

---

## 8. Migration from APK to Termux

### 8.1 Before migrating

1. **Back up sessions**: Menu → Back up sessions (or `POST /api/backup`)
2. **Pull the backup off the phone**: `adb pull` or `scp` or `git`
3. **Note your provider keys** (or they're in `~/.pi/agent/auth.json`)
4. **Note your access mode** (or it's in `~/.pi-mobile/access.json`)

### 8.2 Migration steps

1. Install Termux from F-Droid
2. Run the setup script (Section 4.1)
3. Copy your backup into `~/.pi-mobile/backups/`
4. Restore sessions (extract the backup, or let the bridge import `sessions.json`)
5. Copy `auth.json` to `~/.pi/agent/auth.json`
6. Copy `access.json` to `~/.pi-mobile/access.json`
7. Start the bridge
8. Open a browser, sign in with the bootstrap token

### 8.3 After migrating

1. Uninstall the APK (after confirming everything works)
2. Set up Termux:Boot for auto-start
3. Set up wake lock
4. Exempt Termux from battery optimization
5. Install Tailscale for remote access

---

## 9. What is NOT in this plan (future work)

- **Web Push notifications**: turn completion notifications when the app is in the background. Requires a push service or polling.
- **Multi-user**: the bridge has one active conversation per device, but no user roles. Adding roles would require significant auth changes.
- **HTTPS on the bridge**: the bridge serves HTTP. For remote access, use Tailscale (which provides HTTPS via MagicDNS) or a reverse proxy. The bridge itself should not terminate TLS.
- **Termux:API integration**: clipboard, notifications, sensors via Termux:API. The client already uses the JS Clipboard API, so this is only needed for background notifications.
- **Automatic updates**: the bridge can update pi packages via npm, but the bridge itself and the client need manual updates (git pull + restart).

---

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Phone battery drain | Wake lock + battery optimization exemption. Document clearly. |
| Phone sleeps/kills Termux | Termux foreground service + wake lock. User must configure. |
| Network connectivity loss | PWA caches app shell. Bridge reconnects on SSE error. |
| Phone restarts | Termux:Boot auto-starts bridge. Harness survives (SQLite). |
| Data loss | Backup feature. Document restore procedure. |
| Multiple clients conflict | Single active conversation per device. Steering from one affects all. |
| Agent runs as phone user | Same as current APK. No change in security model. |
| Termux updates break things | Pin Termux package versions. Test before upgrading. |

---

## 11. Timeline estimate

| Phase | Work | Effort |
|---|---|---|
| 1 | Remove Android code, add Termux scripts | 1-2 days |
| 2 | PWA manifest + service worker | 0.5-1 day |
| 3 | Setup documentation | 0.5-1 day |
| 4 | Testing on real phone (Termux) | 1-2 days |
| 5 | Migration guide + verification | 0.5-1 day |
| **Total** | | **3.5-7 days** |

---

## 12. Success criteria

1. Bridge starts in Termux with a single command
2. Bridge survives Termux backgrounding (wake lock)
3. Bridge auto-starts on device reboot (Termux:Boot)
4. Browser on phone can access the bridge and use all features
5. Browser on laptop (via Tailscale) can access the bridge
6. PWA installs on home screen (phone and laptop)
7. All 16 test files pass on Termux
8. Sessions, keys, and extensions survive a bridge restart
9. Backup and restore work end-to-end
10. No Android/APK code remains in the repository