# Termux setup guide

Running pi-mobile directly in Termux, without the Android APK.

## Prerequisites

- An Android phone (aarch64)
- Termux from **F-Droid** (not the Play Store version — it is outdated)
- Termux:Boot from F-Droid (optional, for auto-start on reboot)
- Termux:API from F-Droid (optional, for wake lock and notifications)

## 1. Install Termux

1. Install **Termux** from F-Droid: https://f-droid.org/en/packages/com.termux/
2. Install **Termux:Boot** from F-Droid (optional): https://f-droid.org/en/packages/com.termux.boot/
3. Install **Termux:API** from F-Droid (optional): https://f-droid.org/en/packages/com.termux.api/

## 2. Bootstrap

Open Termux and run:

```bash
pkg update && pkg upgrade -y
pkg install -y nodejs git ripgrep termux-api termux-tools

# Verify Node version (must be >= 22.19.0)
node --version
```

## 3. Install pi-mobile

```bash
git clone https://github.com/<user>/pi-termux-mobile.git ~/pi-mobile
cd ~/pi-mobile
bash scripts/setup-termux.sh
```

Or, if you already have the repo:

```bash
cd ~/pi-mobile
git pull
bash scripts/setup-termux.sh
```

## 4. Start the bridge

```bash
cd ~/pi-mobile
bash scripts/termux-start.sh
```

The bridge prints:

```
pi-mobile durable bridge on 127.0.0.1:8787
bootstrap token: <random-token>
open: http://127.0.0.1:8787/?token=<token>
```

**Save the bootstrap token.** You need it to sign in.

## 5. First access

### On the phone

Open a browser (Chrome, Firefox, etc.) and go to:

```
http://127.0.0.1:8787/?token=<bootstrap-token>
```

The token is exchanged for a cookie. You're in.

### Install as PWA (optional)

1. Open the bridge URL in Chrome
2. Tap the menu (⋮) → "Add to Home Screen"
3. The app icon appears on your home screen
4. Tap it to open in standalone mode

### On another device (Tailscale)

1. Install Tailscale on the phone and the other device
2. Join both to the same tailnet
3. On the phone: in the pi-mobile UI, go to Menu → Access → Tailscale
4. Restart the bridge
5. On the other device: open `http://<phone-tailscale-ip>:8787` or `http://<phone-magicdns>:8787`

### On another device (LAN)

1. On the phone: in the pi-mobile UI, go to Menu → Access → LAN
2. Restart the bridge
3. On the other device: open `http://<phone-lan-ip>:8787`

## 6. Pairing a second device

1. On a signed-in device: Menu → Sign in another device
2. It shows a URL and a code (valid for 15 minutes)
3. On the new device: open the URL and enter the code

## 7. Auto-start on reboot

```bash
mkdir -p ~/.termux/boot
cp ~/pi-mobile/scripts/termux-boot.sh ~/.termux/boot/pi-mobile.sh
chmod +x ~/.termux/boot/pi-mobile.sh
```

Requires Termux:Boot from F-Droid.

## 8. Wake lock

The bridge needs the CPU to stay awake. `termux-start.sh` calls `termux-wake-lock`
automatically. You must also exempt Termux from battery optimization:

1. Android Settings → Apps → Termux → Battery → "Unrestricted" (or "Don't optimize")
2. Android Settings → Apps → Termux:Boot → Battery → "Unrestricted" (if using auto-start)

## 9. Stopping the bridge

```bash
cd ~/pi-mobile
bash scripts/termux-stop.sh
```

## 10. Updating

```bash
cd ~/pi-mobile
git pull
cd runtime && npm ci --omit=dev --omit=optional --ignore-scripts && cd ..
bash scripts/termux-stop.sh
bash scripts/termux-start.sh
```

Or use the in-app updater: Menu → Update pi (updates the pi packages, not the bridge itself).

## 11. Backup and restore

### Backup

```bash
# Via the UI: Menu → Back up sessions
# Or via API:
curl -X POST http://127.0.0.1:8787/api/backup -H 'Cookie: pi=<your-cookie>'
```

The backup is a tar archive in `~/.pi-mobile/backups/`. Pull it off the phone:

```bash
# Via adb (if available):
adb pull /data/data/com.termux/files/home/.pi-mobile/backups/ ./backups/

# Via scp (if sshd is running):
scp -r phone:~/.pi-mobile/backups/ ./backups/

# Via Termux (copy to shared storage):
cp ~/.pi-mobile/backups/*.tar.gz /sdcard/Download/
```

### Restore

1. Copy the backup archive to `~/.pi-mobile/backups/`
2. Extract it: `tar -xzf backup-*.tar.gz -C ~/`
3. Restart the bridge

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Bridge won't start | Node not installed or wrong version | `pkg install nodejs` and verify `node --version` |
| "port in use" | Another bridge is running | `bash scripts/termux-stop.sh` then start again |
| Phone sleeps, bridge stops | Wake lock not acquired | Run `termux-wake-lock` manually |
| Bridge killed in background | Battery optimization | Exempt Termux from battery optimization |
| Can't access from laptop | Access mode is `local` | Set access to `tailscale` or `lan`, restart bridge |
| OAuth fails | Callback URL mismatch | Use Tailscale MagicDNS or ngrok for a stable public URL |
| Sessions lost after reboot | Termux:Boot not configured | Set up auto-start (Section 7) |

## 13. Differences from the APK version

| Feature | APK | Termux |
|---|---|---|
| Install | Sideloading APK | `pkg install` + `git clone` |
| Process supervision | Android foreground service | Termux foreground service + watchdog |
| Wake lock | Java `PowerManager` | `termux-wake-lock` |
| Notifications | Android notification API | Termux:API (optional) or none |
| Auto-start | Android boot receiver | Termux:Boot |
| Updates | APK reinstall | `git pull` + restart |
| Runtime | Bundled Termux (rewritten prefix) | System Termux (`pkg install`) |
| Prefix | `/data/data/app.pidabl/files/usr` | `/data/data/com.termux/files/usr` |
| Client | WebView inside app | Any browser (PWA) |
| Offline | Full offline | PWA caches app shell only |
EOF