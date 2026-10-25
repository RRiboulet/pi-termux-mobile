# Reaching the bridge: sign-in, devices, and access modes

The bridge is a small server holding your API keys and running commands as you.
Everything here is about keeping that reachable by *you* and by nobody else.

## The three modes

Set it in the app (**Menu → Access**, which writes `$HOME/.pi-mobile/access.json`) or with
`PI_ACCESS` when the bridge starts (`PI_ACCESS=tailscale node runtime/server.mjs`). A change
needs a restart: it decides what the server binds.

The file is what makes the mode reachable from the phone — there is nowhere to put an
environment variable when PiService starts node, and rebuilding an APK to change an
access mode would be absurd. The env var still wins when it is set, so a dev run can
override whatever the app last chose.

| mode | binds | who can reach it |
|---|---|---|
| `local` (default) | `127.0.0.1` | this phone only — which is what the APK's WebView needs |
| `tailscale` | the phone's tailnet address (`100.64.0.0/10`) | devices on your tailnet, and nothing on the LAN |
| `lan` | `0.0.0.0` | anything on the network. Ring the bell before using it |

`PI_HOSTNAME` adds names to the Host allow-list (`PI_HOSTNAME=phone.tailnet.ts.net`),
which is what makes a MagicDNS name work. In `tailscale` mode a peer that is itself
on the tailnet is allowed whatever Host it sends: it cannot be reached by a hostile
page, and the cookie is host-only anyway.

The Host check is not ceremony. A DNS-rebinding attack works by pointing a domain at
your address and letting the browser send the *attacker's* name; on a server whose
only credential is a cookie, a name that is not ours must not get in. That is what the
421 is.

## Signing in a device

A device proves itself once, and then holds a cookie:

1. On a signed-in device: **Menu → Sign in another device**. It prints an address and
   a code, good for 15 minutes or one use.
2. On the new device open that address (or open the app and type the code).
3. `POST /api/session` either takes that code and issues a device token, or takes the
   bootstrap token and turns it into a cookie. The cookie is `HttpOnly` and
   `SameSite=Strict`: no script can read it, and it is not sent from another site.

Only the **SHA-256** of a token is on disk (`$HOME/.pi-mobile/devices.json`), so the
file is not a key. `GET /api/devices` lists ids and names, never secrets.

## Signing everything out

**Menu → Sign out every other device** (`POST /api/token/rotate`) writes a new bootstrap
token, issues this device a fresh cookie, and forgets every other one — including the
token the Android host was launched with. Use it when a phone is lost, or when a
pairing link may have leaked. A script that needs to keep working keeps the new
bootstrap token the response returns.

**Menu → Sign out this device** clears the cookie only.

## What a device can do

Everything. There are no roles: whoever is signed in can steer the agent, which means
running commands as you, reading your files and your keys. Invite nobody you would not
hand your phone to.
