package org.pimobile.app.test;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.webkit.WebView;
import java.io.File;
import java.nio.file.Files;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

/** Signed test APK only. Exercises rendered forms; secrets stay in target-private input. */
public final class SpaceUiInstrumentation extends Instrumentation {
    private Bundle arguments;
    private WebView web;
    @Override public void onCreate(Bundle args) { arguments = args; super.onCreate(args); start(); }
    private String js(String source) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> reply = new AtomicReference<>();
        runOnMainSync(() -> web.evaluateJavascript(source, value -> { reply.set(value); done.countDown(); }));
        if (!done.await(10, TimeUnit.SECONDS)) throw new Exception("UI evaluation timed out");
        return reply.get();
    }
    private JSONObject snapshot() throws Exception {
        String encoded = js("JSON.stringify({message:document.getElementById('space-message')?.textContent,result:document.getElementById('space-result')?.textContent,tokenCleared:document.getElementById('enroll-token')?.value===''})");
        Object decoded = new org.json.JSONTokener(encoded).nextValue();
        return new JSONObject(String.valueOf(decoded));
    }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            Intent intent = new Intent(); intent.setClassName(getTargetContext(), "org.pimobile.app.MainActivity"); intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            Activity activity = startActivitySync(intent);
            java.lang.reflect.Field field = activity.getClass().getDeclaredField("webView"); field.setAccessible(true); web = (WebView) field.get(activity);
            long deadline = System.currentTimeMillis() + 90000;
            while (!"true".equals(js("location.host.startsWith('127.0.0.1:') && !!document.querySelector('a[href*=\"spaces.html\"]')"))) {
                if (System.currentTimeMillis() > deadline) throw new Exception("bridge page not ready"); Thread.sleep(500);
            }
            js("document.querySelector('a[href*=\"spaces.html\"]').click()");
            while (!"true".equals(js("!!document.getElementById('prepare') && document.getElementById('space-message').textContent==='Ergebnis empfangen'"))) {
                if (System.currentTimeMillis() > deadline) throw new Exception("spaces page not ready"); Thread.sleep(300);
            }
            File privateInput = new File(getTargetContext().getFilesDir(), "home/.pi-mobile/ui-pairing-input.json");
            JSONObject input = new JSONObject(new String(Files.readAllBytes(privateInput.toPath()), java.nio.charset.StandardCharsets.UTF_8));
            String mode = arguments.getString("mode", "status");
            if ("prepare".equals(mode) || "data".equals(mode)) {
                JSONObject values = input.getJSONObject(mode);
                String form = "prepare".equals(mode) ? "prepare" : "data";
                js("(()=>{const f=document.getElementById(" + JSONObject.quote(form) + "),v=" + values.toString() + ";for(const [k,value] of Object.entries(v)){f.elements.namedItem(k).value=value;}f.requestSubmit();return true;})()");
            } else if ("pair".equals(mode)) {
                js("(()=>{document.getElementById('enroll-token').value=" + JSONObject.quote(input.getJSONObject("qr").toString()) + ";document.getElementById('pair').requestSubmit();return true;})()");
            } else {
                if (!java.util.Arrays.asList("authenticate", "enrollStatus", "objects", "rotationStatus").contains(mode)) throw new Exception("unsupported UI action");
                js("document.querySelector('[data-action=" + mode + "]').click()");
            }
            Thread.sleep(200);
            deadline = System.currentTimeMillis() + 60000;
            JSONObject screen;
            while (true) {
                screen = snapshot(); String message = screen.optString("message");
                if ("Ergebnis empfangen".equals(message)) break;
                if (!message.startsWith("Läuft")) throw new Exception("UI request refused: " + message);
                if (System.currentTimeMillis() > deadline) throw new Exception("UI result timed out"); Thread.sleep(300);
            }
            JSONObject reply = new JSONObject(screen.getString("result"));
            result.putBoolean("passed", true); result.putString("action", mode);
            result.putString("profileState", reply.optJSONObject("profile") == null ? "" : reply.getJSONObject("profile").optString("state"));
            result.putBoolean("tokenCleared", screen.optBoolean("tokenCleared"));
            if (reply.optJSONObject("profile") != null) result.putString("keyId", reply.getJSONObject("profile").optString("keyId"));
            if (reply.optJSONObject("result") != null && reply.getJSONObject("result").optJSONArray("objects") != null) result.putInt("objects", reply.getJSONObject("result").getJSONArray("objects").length());
            finish(Activity.RESULT_OK, result);
        } catch (Exception error) { result.putBoolean("passed", false); result.putString("error", error.getMessage()); finish(Activity.RESULT_CANCELED, result); }
    }
}
