# Installing over wireless adb

`install-wifi.sh` at the repo root is the usual path: it discovers the phone
over mDNS, pairs if needed, connects and installs. This page is the fallback and
the explanation behind it, for the cases that script does not cover — a phone
that does not advertise over mDNS, a Windows host, or an adb endpoint that sits
at `offline` and never recovers.

## The two endpoints that get confused

Wireless debugging involves **two different endpoints**, and they are not
interchangeable:

| Where it is | What it is for |
|---|---|
| inside the "Pair device with pairing code" dialog | pairing only; the 6-digit code expires after a minute or so |
| the main Wireless debugging screen ("IP address & port") | connecting, from then on |

The connect port **rotates** every time wireless debugging is toggled off and
on, or the phone reboots. Pairing does not: the phone remembers this host after
the first successful pair, so only `adb connect` has to be repeated. A "connect"
attempted against the pairing port fails, and vice versa — this is the most
common way to lose an afternoon here.

`scripts/find-adb-port.sh <phone-ip>` finds the current connect port,
`scripts/pair-install.sh <pair-ip:port> <code> <connect-ip:port>` runs pair →
connect → install → smoke with retries, and `scripts/watch-adb.sh
<connect-ip:port>` waits out an `offline` transport.

## Do not scan the whole port range

`find-adb-port.sh` scans 36000–47000 with 16 workers, and that bound is
deliberate. A 250-wide sweep over the full range spawned ~16,000 short-lived
processes in a devcontainer whose PID 1 is `sleep`; `sleep` never reaps orphans,
so they stayed as zombies and the container hit its process ceiling and could no
longer fork a shell. Recovery is a restart of the container — the PID namespace
is destroyed and recreated — and nothing on disk is lost. One open port was all
that was needed.

The script keeps that lesson in its shape rather than its comments: it scans only
the range adb actually uses, caps concurrency at 16, reaps through `xargs` (so
killing it leaves at most the in-flight 16, not thousands), validates the address
before it is ever interpolated into a child shell, and reports every port that
answers once the scan finishes. Do not raise `-P` and do not widen the range.

## When adb cannot be made to work at all

It is not always necessary. The app is debuggable, so a copy pushed over
`ssh`/`scp` to `/storage/emulated/0/Download/` installs from the phone's own file
manager, and the phone's own Termux can read the app's files. This is the case
`docs/device-verification.md` records, where the wireless handshake never
completed and everything was checked over ssh instead.

With adb working, the same state is one command away — `run-as` reaches the
app's files because the build is debuggable:

```bash
adb shell run-as app.pidabl cat files/log/node.log          # the bridge's log
adb shell run-as app.pidabl cat files/home/.pi-mobile/port  # the port it chose
```

The port is ephemeral and changes on every restart, so read it rather than
remembering it. Without adb, the phone-side `pistatus` helper answers the same
questions over ssh (see `docs/device-verification.md`).

## Windows

`scripts/install-pi.bat` is the same install step for a Windows host: it finds
`adb` in the usual Android Studio / platform-tools locations, lists the attached
devices, installs `-r` the APK and prints the two `run-as` commands above. Pass
an APK path as the first argument to install something other than
`android/app/build/outputs/apk/debug/app-debug.apk`.

The file is CRLF on purpose. `cmd.exe` documents CRLF, and an LF-only `.bat`
intermittently fails to find its own labels (`goto :done` here), which reads as a
broken script rather than a line-ending problem.
