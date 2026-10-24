# Backup and restore

Sessions and API keys live in the app's `HOME` (`files/home`), and an uninstall
deletes that without asking. The one thing you can do about it today is take a
backup and pull it off the phone.

The procedure below is run by `test/restore-e2e.test.mjs`: a live bridge is backed
up, killed, its database deleted, and the archive extracted exactly as written
here — the sessions and their text have to come back. If this document and that
test disagree, the document is wrong.

## Taking a backup

**Menu → Back up sessions.** It writes
`$HOME/.pi-mobile/backups/pi-backup-<UTC stamp>.tar.gz` and shows you the path.
Ten are kept; older ones are deleted.

The archive is laid out **relative to `HOME`**:

```
.pi-mobile/harness.sqlite     the sessions, transcripts, usage, tasks
.pi-mobile/backup.json        when it was taken, how big, and how the database was copied
.pi/agent/auth.json           provider keys            (when present)
.pi/agent/models.json         model choices            (when present)
```

The database is copied with SQLite's own `.backup`, not by copying the file: the
bridge is writing to it, and a copy of a database mid-write restores into a broken
app. If `sqlite3` is not available the server falls back to a plain copy, and
`backup.json` says so — a restore from such an archive is best-effort.

**It does not contain** the agent's working directory (`files/work`), the backups
themselves, or anything under `usr/` and `runtime/` (those come from the APK).
A backup from a different bridge version may be refused by the schema; restore it
onto the build that wrote it.

**The copy is on the phone too.** An uninstall deletes `files/`, backups included,
so pull the archive off before uninstalling:

```bash
adb pull /data/data/app.pidabl/files/home/.pi-mobile/backups/pi-backup-….tar.gz
# or, on a phone with sshd:  scp -P 8022 localhost:<path> .
# or commit it somewhere with git, which is in the app's own rootfs
```

## Restoring

Nothing may be writing to the database while it is replaced, and that includes the
agent — a restore replaces the store it is running out of.

`FILES` below is the app's data directory; `/data/data/app.pidabl` and
`/data/user/0/app.pidabl` are the same place.

```bash
FILES=/data/data/app.pidabl/files
ARCHIVE=$FILES/home/.pi-mobile/backups/pi-backup-2026-10-24T12-00-00.tar.gz
```

1. **Stop the app completely** — Settings → Apps → *pi mobile* → **Force stop**.
   Not just Back: `PiService` restarts node within a second, and node opens the
   database on start.

2. **Look at what you are about to restore.** The archive should hold
   `.pi-mobile/harness.sqlite`; anything else is a different archive.

   ```bash
   tar -tzf "$ARCHIVE"
   ```

3. **Drop the database, including its write-ahead log.** A stale `-wal` replayed
   over a restored file is a corrupt database, and this is the step that is easy
   to skip.

   ```bash
   rm -f "$FILES/home/.pi-mobile/harness.sqlite" \
         "$FILES/home/.pi-mobile/harness.sqlite-wal" \
         "$FILES/home/.pi-mobile/harness.sqlite-shm"
   ```

4. **Restore.** The archive is laid out relative to `HOME`, so this one command
   puts the database and the credentials back where the bridge reads them. It
   overwrites `auth.json` and `models.json` with the versions from the backup.

   ```bash
   tar -xzf "$ARCHIVE" -C "$FILES/home"
   ```

5. **Relaunch the app.** The sessions sheet should list what the archive held,
   with the transcripts intact.

## If it does not come back

- **The app starts to a blank screen, or the sessions list is empty.** Check that
  step 3 ran: a `harness.sqlite-wal` next to the restored database is the usual
  cause. Force stop, delete the `-wal`/`-shm`, relaunch.
- **The bridge exits immediately.** Read `files/log/node.log` — the schema will
  refuse a backup from a newer bridge. Restore the build that wrote the archive.
- **`auth.json` is back but the provider list is empty.** That file is only in the
  archive if it existed when the backup was taken; `Menu → Provider` shows what
  the bridge can see.
- **You are past the point of no return.** There is no undo, which is why step 2
  exists and why the restore is run by hand.
