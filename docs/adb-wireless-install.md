# Installing over wireless adb

`install-wifi.sh` at the repo root is the usual path: it discovers the phone
over mDNS, pairs if needed, connects and installs. This page is the fallback and
the explanation behind it, for the cases that script does not cover — a phone
that does not advertise over mDNS, a Windows host, or an adb endpoint that sits
at `offline` and never recovers.

## The three ports that get confused

Wireless debugging involves **two different endpoints**, and they are not
interchangeable:

| Where it is | What it is for |
|---|---|
| inside the "Pair device with pairing code" dialog | pairing only; expires in about a minute |
| the main Wireless debugging screen ("IP address & port") | connecting, from then on |

The connect port **rotates** every time wireless debugging is toggled off and
on, or the phone reboots. Pairing does not: the phone remembers this host
after the first successful pair, so only `adb connect` has to be repeated.
A "connect" attempted against the pairing port fails, and vice versa — this is
the most common way to lose an afternoon here.

`scripts/find-adb-port.sh <phone-ip>` finds the current connect port,
`scripts/pair-install.sh <pair-ip:port> <code> <connect-ip:port>` runs the whole
pair → connect → install → smoke sequence with retries, and
`scripts/watch-adb.sh <connect-ip:port>` waits out an `offline` transport.

## Do not scan the whole port range

`find-adb-port.sh` scans 36000–47000 with 16 workers, and that bound is
deliberate. A 250-wide sweep over the full range spawned ~16,000 short-lived
processes in a devcontainer whose PID 1 is `sleep`; `sleep` never reaps
orphans, so they stayed as zombies and the container hit its process ceiling and
could no longer fork a shell. Recovery is a restart of the container — the PID
namespace is destroyed and recreated — and nothing on disk is lost. One open
port was all that was needed.

## When adb cannot be made to work at all

It is not always necessary. The app is debuggable, so a copy pushed over
`ssh`/`scp` to `/storage/emulated/0/Download/` installs from the phone's own
file manager, and `run-as` still reaches the app's files. `docs/device-verification.md`
has the recorded instance of this, including how the install is verified.

Once the app is running, its state can be read without adb:

```bash
adb shell run-as app.pidabl cat files/log/node.log      # the bridge's log
adb shell run-as app.pidabl cat files/home/.pi-mobile/port   # the port it chose
```

The port is ephemeral and changes on every restart, so read it rather than
remembering it.

## Windows

`scripts/install-pi.bat` is the same install step for a Windows host: it finds
`adb` in the usual Android Studio / platform-tools locations, lists the attached
devices, installs `-r` the APK and prints the two `run-as` commands above. Pass
an APK path as the first argument to install something other than
`android/app/build/outputs/apk/debug/app-debug.apk`.
