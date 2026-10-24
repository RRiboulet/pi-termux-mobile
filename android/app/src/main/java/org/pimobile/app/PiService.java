package org.pimobile.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.util.ArrayList;
import org.json.JSONObject;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Foreground service owning the Node bridge process.
 * Layout under filesDir:
 *   usr/      termux prefix (bin, lib, etc.)
 *   home/     HOME ($HOME/.pi/agent for auth.json, $HOME/.pi-mobile for bridge state)
 *   work/     default agent working directory
 *   runtime/  server.mjs + node_modules
 *   tmp/      TMPDIR
 *
 * Exactly one node process runs per service. Every Activity start calls
 * startForegroundService(); that must not restart a running bridge, because
 * a restart interrupts the agent's running tool calls and pi-durable allows a
 * single storage owner. A supervisor restarts node with backoff if it dies.
 */
public final class PiService extends Service {

    private static final String CHANNEL = "pi-runtime";
    // A second channel, because the ongoing one is deliberately silent: a turn that
    // ends while the app is in the background is news, and news is allowed to buzz.
    private static final String TURN_CHANNEL = "pi-turns";
    private static final int ONGOING_ID = 1;
    private static final int FINISHED_ID = 2;
    private static final long STOP_GRACE_MS = 8000;

    private final Object lock = new Object();
    private Process nodeProcess;
    private Thread supervisor;
    private Thread statusWatcher;

    /**
     * Set by MainActivity: a finished turn is only worth a notification when nobody
     * is looking at the screen.
     */
    public static volatile boolean appVisible = false;
    private volatile boolean stopping;
    private PowerManager.WakeLock wakeLock;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundWithNotification();
        acquireWakeLock();
        synchronized (lock) {
            if (supervisor != null && supervisor.isAlive()) return START_STICKY; // already running
            stopping = false;
            supervisor = new Thread(this::superviseNode, "pi-supervisor");
            supervisor.start();
            if (statusWatcher == null || !statusWatcher.isAlive()) {
                statusWatcher = new Thread(this::watchStatus, "pi-status");
                statusWatcher.setDaemon(true);
                statusWatcher.start();
            }
        }
        return START_STICKY;
    }

    /** Install if needed, then keep one node process alive (restart with backoff). */
    private void superviseNode() {
        try {
            if (!RuntimeInstaller.isInstalled(this)) {
                terminateOrphanServer(); // must not run while its files are replaced
                RuntimeInstaller.install(this);
            }
        } catch (Exception e) {
            logError("install failed", e);
            stopSelf();
            return;
        }
        long backoff = 1000;
        while (!stopping) {
            long started = System.currentTimeMillis();
            Process p;
            try {
                p = startNode();
            } catch (Exception e) {
                logError("node start failed", e);
                p = null;
            }
            if (p != null) {
                synchronized (lock) { nodeProcess = p; }
                try {
                    int code = p.waitFor();
                    // Exit 0 is a deliberate stop (an update swapping its modules in),
                    // not a failure: logging it as one buried the exits that mattered.
                    if (!stopping && code != 0) logError("node exited " + code + "; restarting", null);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return;
                }
                synchronized (lock) { if (nodeProcess == p) nodeProcess = null; }
            }
            if (stopping) return;
            // a process that ran for a while gets a quick restart again
            if (System.currentTimeMillis() - started > 60_000) backoff = 1000;
            try { Thread.sleep(backoff); } catch (InterruptedException ie) { return; }
            backoff = Math.min(backoff * 2, 30_000);
        }
    }

    private Process startNode() throws IOException {
        File files = getFilesDir();
        File prefix = new File(files, "usr");
        File home = new File(files, "home");
        File runtime = new File(files, "runtime");

        Map<String, String> env = new HashMap<>();
        env.put("HOME", home.getAbsolutePath());
        // The prefix as the Termux binaries have it compiled in, not as the filesystem spells it: getFilesDir() is
        // /data/user/0/<id>/files, while the binaries were built for /data/data/<id>/files. Same directory, different
        // string, and pkg/dpkg compare the compiled-in one. scripts/package-rootfs.ts rewrote them to ours.
        String prefixPath = "/data/data/" + getPackageName() + "/files/usr";
        env.put("PREFIX", prefixPath);
        env.put("TMPDIR", new File(files, "tmp").getAbsolutePath());
        env.put("PATH", prefixPath + "/bin:/system/bin:/system/xbin");
        env.put("LD_LIBRARY_PATH", prefixPath + "/lib");
        env.put("TERM", "dumb");
        env.put("LANG", "C.UTF-8");
        env.put("PI_WORKDIR", new File(files, "work").getAbsolutePath());
        env.put("PI_SHELL", new File(prefix, "bin/bash").getAbsolutePath());
        // Termux-built openssl hardcodes /data/data/com.termux paths — point at ours.
        env.put("OPENSSL_CONF", new File(prefix, "etc/tls/openssl.cnf").getAbsolutePath());
        env.put("SSL_CERT_FILE", new File(prefix, "etc/tls/cert.pem").getAbsolutePath());
        // termux-exec intercepts every exec, so a `#!/usr/bin/env ...` script finds its interpreter and a child
        // process of node (bash, git, rg) is launched the way Termux launches them. It is NOT needed to escape
        // the API-29+ exec ban: at targetSdk 28 there is no ban, and app-private binaries can be exec'd directly.
        // The prefix inside the preload library was rewritten to ours by the rootfs builder.
        env.put("LD_PRELOAD", new File(prefix, "lib/libtermux-exec-ld-preload.so").getAbsolutePath());
        env.put("TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE", "force");
        env.put("TERMUX_EXEC__EXECVE_CALL__INTERCEPT", "1");

        // a stale port file would make the UI load a dead bridge address
        new File(new File(home, ".pi-mobile"), "port").delete();

        String node = new File(prefix, "bin/node").getAbsolutePath();
        String server = new File(runtime, "server.mjs").getAbsolutePath();

        List<String> cmd = new ArrayList<>();
        cmd.add(node);
        cmd.add(server);
        try {
            return spawn(cmd, env, home);
        } catch (IOException directFailed) {
            // targetSdk >= 29 on Android 10+: exec of app-private files is
            // blocked -> run the ELF through the system dynamic linker.
            cmd.set(0, "/system/bin/linker64");
            cmd.add(1, node);
            return spawn(cmd, env, home);
        }
    }

    private Process spawn(List<String> cmd, Map<String, String> env, File cwd) throws IOException {
        File log = new File(getFilesDir(), "log/node.log");
        log.getParentFile().mkdirs();
        rotateLog(log);
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.environment().putAll(env);
        pb.directory(cwd);
        pb.redirectErrorStream(true);
        pb.redirectOutput(ProcessBuilder.Redirect.appendTo(log));
        return pb.start();
    }

    private static void rotateLog(File log) {
        if (log.length() > 4L * 1024 * 1024) {
            File old = new File(log.getPath() + ".1");
            old.delete();
            log.renameTo(old);
        }
    }

    /**
     * Graceful stop: SIGTERM (server.mjs closes the harness and releases its
     * storage lock), wait, then kill. The pid comes from server.mjs's lock file.
     */
    private void stopNode() {
        Process p;
        synchronized (lock) { p = nodeProcess; }
        if (p == null) return;
        int pid = readServerPid();
        if (pid > 0) {
            try { android.os.Process.sendSignal(pid, 15); } catch (Exception ignored) { }
        } else {
            p.destroy();
        }
        try {
            if (!p.waitFor(STOP_GRACE_MS, TimeUnit.MILLISECONDS)) {
                p.destroyForcibly();
                p.waitFor(2000, TimeUnit.MILLISECONDS);
            }
        } catch (InterruptedException ie) {
            p.destroyForcibly();
            Thread.currentThread().interrupt();
        }
    }

    /** A node left over from a killed app process (same uid) still owns the storage. */
    private void terminateOrphanServer() {
        int pid = readServerPid();
        if (pid <= 0 || !isServerProcess(pid)) return;
        android.os.Process.sendSignal(pid, 15);
        for (int i = 0; i < 80 && isServerProcess(pid); i++) {
            try { Thread.sleep(100); } catch (InterruptedException ie) { return; }
        }
        if (isServerProcess(pid)) android.os.Process.sendSignal(pid, 9);
    }

    private static boolean isServerProcess(int pid) {
        try (FileInputStream in = new FileInputStream("/proc/" + pid + "/cmdline")) {
            byte[] b = new byte[4096];
            int n = in.read(b);
            return n > 0 && new String(b, 0, n, "UTF-8").contains("server.mjs");
        } catch (Exception e) {
            return false;
        }
    }

    private int readServerPid() {
        File f = new File(new File(new File(getFilesDir(), "home"), ".pi-mobile"), "server.lock");
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] b = new byte[(int) Math.min(f.length(), 4096)];
            int n = in.read(b);
            Matcher m = Pattern.compile("\"pid\"\\s*:\\s*(\\d+)").matcher(new String(b, 0, Math.max(n, 0), "UTF-8"));
            return m.find() ? Integer.parseInt(m.group(1)) : -1;
        } catch (Exception e) {
            return -1;
        }
    }

    private void logError(String msg, Exception e) {
        android.util.Log.e("PiService", msg, e);
        try {
            File f = new File(getFilesDir(), "log/service-error.txt");
            f.getParentFile().mkdirs();
            try (java.io.FileWriter w = new java.io.FileWriter(f, true)) {
                w.write(new java.util.Date() + " " + msg + (e != null ? ": " + e : "") + "\n");
            }
        } catch (IOException ignored) { }
    }

    private void startForegroundWithNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(
                    CHANNEL, "pi runtime", NotificationManager.IMPORTANCE_LOW));
        }
        Notification n = buildOngoing("starting\u2026");
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(ONGOING_ID, n,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(ONGOING_ID, n);
        }
    }

    private synchronized void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pimobile:runtime");
            wakeLock.setReferenceCounted(false); // repeated starts must not stack holds
        }
        if (!wakeLock.isHeld()) wakeLock.acquire();
    }

    /**
     * Follow what the bridge is doing, for the notification.
     *
     * The bridge writes $HOME/.pi-mobile/status.json when a run starts, when a tool
     * starts, and when the run ends; this reads it once a second. It is a file and
     * not a socket because node cannot post a notification and Android cannot see
     * inside node — the file is the whole interface between them.
     */
    private void watchStatus() {
        final File file = new File(new File(new File(getFilesDir(), "home"), ".pi-mobile"), "status.json");
        String shownText = null;
        long shownFinishedAt = -1;
        while (!stopping) {
            try {
                if (file.isFile()) {
                    JSONObject st = new JSONObject(readText(file));
                    String state = st.optString("state", "idle");
                    String tool = st.optString("tool", "");
                    long finishedAt = st.optLong("finishedAt", 0);
                    String text = "working".equals(state)
                            ? (tool.isEmpty() ? "working" : "working \u00b7 " + tool)
                            : "idle";
                    if (!text.equals(shownText)) {
                        shownText = text;
                        updateOngoing(text);
                    }
                    if (shownFinishedAt < 0) {
                        shownFinishedAt = finishedAt;   // adopt: a restart is not a finish
                    } else if (finishedAt > shownFinishedAt) {
                        shownFinishedAt = finishedAt;
                        if (!appVisible) postFinished(tool);
                    }
                }
            } catch (Exception ignored) {
                // A half-written file or no bridge yet: try again next tick.
            }
            try {
                Thread.sleep(1000);
            } catch (InterruptedException ie) {
                return;
            }
        }
    }

    private void updateOngoing(String text) {
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            nm.notify(ONGOING_ID, buildOngoing(text));
        } catch (Exception ignored) {
        }
    }

    /** A turn ended with the app in the background. */
    private void postFinished(String tool) {
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (Build.VERSION.SDK_INT >= 26) {
                nm.createNotificationChannel(new NotificationChannel(
                        TURN_CHANNEL, "finished turns", NotificationManager.IMPORTANCE_DEFAULT));
            }
            Intent open = new Intent(this, MainActivity.class);
            PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, TURN_CHANNEL)
                    : new Notification.Builder(this);
            b.setContentTitle("pi finished")
                    .setContentText(tool.isEmpty() ? "the turn is done" : "the turn is done \u00b7 " + tool)
                    .setSmallIcon(android.R.drawable.ic_media_play)
                    .setContentIntent(pi)
                    .setAutoCancel(true);
            nm.notify(FINISHED_ID, b.build());
        } catch (Exception ignored) {
        }
    }

    private static String readText(File f) throws IOException {
        FileInputStream in = new FileInputStream(f);
        try {
            byte[] buf = new byte[(int) f.length()];
            int read = 0;
            while (read < buf.length) {
                int n = in.read(buf, read, buf.length - read);
                if (n < 0) break;
                read += n;
            }
            return new String(buf, 0, read, "UTF-8");
        } finally {
            try { in.close(); } catch (IOException ignored) { }
        }
    }

    private Notification buildOngoing(String text) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        return b.setContentTitle("pi mobile")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentIntent(pi)
                .build();
    }

    @Override
    public void onDestroy() {
        stopping = true;
        Thread sup;
        synchronized (lock) { sup = supervisor; supervisor = null; }
        stopNode();
        if (sup != null) sup.interrupt();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }
}
