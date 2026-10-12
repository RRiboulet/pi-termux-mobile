package org.pimobile.app;

import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Process;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.UUID;

/** UID-checked local signer. Private keys never leave Android Keystore. No WebView signing interface. */
final class SpaceKeyStore implements AutoCloseable {
    private final LocalServerSocket server;
    private final KeyStore store;
    private volatile boolean closed;
    private final android.content.SharedPreferences bindings;
    static String socketName() { return "pi-spaces-key-" + Process.myUid(); }
    SpaceKeyStore(android.content.Context context) throws Exception {
        store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        bindings = context.getSharedPreferences("pi-spaces-key-bindings", android.content.Context.MODE_PRIVATE);
        server = new LocalServerSocket(socketName());
        Thread thread = new Thread(this::serve, "space-keystore"); thread.setDaemon(true); thread.start();
    }
    private void serve() {
        while (!closed) try (LocalSocket client = server.accept()) {
            client.setSoTimeout(5000);
            if (client.getPeerCredentials().getUid() != Process.myUid()) continue;
            JSONObject reply;
            try {
                InputStream in = client.getInputStream(); java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
                int b; while ((b = in.read()) != -1 && b != '\n') { if (bytes.size() >= 16384) throw new Exception("request too large"); bytes.write(b); }
                reply = new JSONObject().put("ok", true).put("result", handle(new JSONObject(bytes.toString("UTF-8"))));
            } catch (Exception e) { reply = new JSONObject().put("ok", false).put("error", e.getMessage() == null ? "keystore refused request" : e.getMessage()); }
            client.getOutputStream().write((reply.toString() + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) { /* shutdown, or an invalid local caller */ }
    }
    private static String checkedId(String id) throws Exception { if (!id.matches("[A-Za-z0-9_.:-]{1,128}")) throw new Exception("invalid identity"); return id; }
    private String alias(JSONObject call) throws Exception { String alias = call.getString("alias"); if (!alias.matches("pi-spaces/[a-f0-9-]{36}")) throw new Exception("invalid key alias"); return alias; }
    private JSONObject publicInfo(String alias) throws Exception {
        if (!store.containsAlias(alias)) throw new Exception("unknown keystore key");
        byte[] pub = store.getCertificate(alias).getPublicKey().getEncoded();
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(pub); StringBuilder hex = new StringBuilder();
        for (byte b : digest) hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return new JSONObject().put("alias", alias).put("algorithm", "ecdsa-p256").put("publicKey", Base64.encodeToString(pub, Base64.NO_WRAP)).put("keyId", hex.substring(0, 32));
    }
    private synchronized JSONObject handle(JSONObject call) throws Exception {
        String method = call.getString("method");
        if ("create".equals(method)) {
            String peer = checkedId(call.getString("peerId")), host = checkedId(call.getString("gateHostId"));
            String alias = "pi-spaces/" + UUID.randomUUID();
            KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY).setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).setUserAuthenticationRequired(false).build());
            generator.generateKeyPair();
            if (!bindings.edit().putString(alias + ":peer", peer).putString(alias + ":host", host).commit()) { store.deleteEntry(alias); throw new Exception("key binding could not be persisted"); }
            return publicInfo(alias);
        }
        String alias = alias(call); JSONObject info = publicInfo(alias);
        if ("publicKey".equals(method)) return info;
        if ("allowHost".equals(method)) {
            String host = checkedId(call.getString("gateHostId"));
            String old = bindings.getString(alias + ":host", "");
            java.util.Set<String> hosts = new java.util.HashSet<>(bindings.getStringSet(alias + ":hosts", java.util.Collections.singleton(old)));
            hosts.add(host);
            if (hosts.size() > 64 || !bindings.edit().putStringSet(alias + ":hosts", hosts).commit()) throw new Exception("host binding could not be persisted");
            return info;
        }
        if (!"sign".equals(method)) throw new Exception("unsupported keystore operation");
        byte[] bytes = Base64.decode(call.getString("bytes"), Base64.DEFAULT);
        if (bytes.length > 8192) throw new Exception("signing request too large");
        String message = new String(bytes, StandardCharsets.UTF_8), domain;
        if (message.startsWith("pi-spaces/auth/v1\n")) domain = "pi-spaces/auth/v1\n";
        else if (message.startsWith("pi-spaces/rotate/v1\n")) domain = "pi-spaces/rotate/v1\n";
        else throw new Exception("only space authentication and rotation can be signed");
        JSONObject proof = new JSONObject(message.substring(domain.length()));
        String peer = bindings.getString(alias + ":peer", ""), host = bindings.getString(alias + ":host", "");
        long now = System.currentTimeMillis(), issued = proof.getLong("issuedAt");
        if (issued > now + 2000 || issued < now - 32000) throw new Exception("stale signing request");
        if (domain.contains("auth")) {
            java.util.Set<String> hosts = bindings.getStringSet(alias + ":hosts", java.util.Collections.singleton(host));
            if (!peer.equals(proof.getString("observedPeerId")) || !hosts.contains(proof.getString("gateHostId")) || proof.getInt("protocol") != 1 || !proof.getString("connNonce").matches("[a-f0-9]{64}")) throw new Exception("challenge identity mismatch");
        } else {
            if (!peer.equals(proof.getString("peerId")) || (!info.getString("keyId").equals(proof.getString("oldKeyId")) && !info.getString("keyId").equals(proof.getString("newKeyId"))) || proof.getLong("expiresAt") <= now || proof.getLong("expiresAt") - issued > 30000 || !proof.getString("nonce").matches("[a-f0-9]{64}")) throw new Exception("rotation identity mismatch");
        }
        Signature signature = Signature.getInstance("SHA256withECDSA"); signature.initSign((java.security.PrivateKey) store.getKey(alias, null)); signature.update(bytes);
        return new JSONObject().put("signature", Base64.encodeToString(signature.sign(), Base64.NO_WRAP));
    }
    @Override public void close() { closed = true; try { server.close(); } catch (Exception ignored) {} }
}
