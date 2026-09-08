package com.datashield.vehiclecallalert;

import android.content.Context;
import android.text.TextUtils;
import android.util.Log;

import androidx.annotation.Nullable;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Registers this device with the wake-up server so incoming calls can be delivered by a
 * high priority push message instead of a permanently connected background service.
 *
 * <p>The server only ever stores <em>vehicle number -&gt; push token</em>. When somebody scans a
 * QR code the call page asks the server to ring that vehicle, the server sends the push, and
 * {@link PushService} wakes the app for the few seconds a call needs.</p>
 *
 * <p>Everything here degrades gracefully: without a Firebase configuration or without a server
 * URL the app falls back to the always-connected foreground service.</p>
 */
public final class PushRegistrar {

    private static final String TAG = "PushRegistrar";
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    private PushRegistrar() {
    }

    /** True when both a push token and a wake-up server are available. */
    public static boolean isConfigured(Context context) {
        return !TextUtils.isEmpty(Prefs.getPushToken(context))
                && !TextUtils.isEmpty(Prefs.getServerUrl(context));
    }

    /** Asks Firebase for the current token (no-op when Firebase is not set up). */
    public static void refreshToken(final Context context) {
        final Context app = context.getApplicationContext();
        try {
            com.google.firebase.messaging.FirebaseMessaging.getInstance().getToken()
                    .addOnSuccessListener(token -> onToken(app, token))
                    .addOnFailureListener(e -> Log.i(TAG, "No push token: " + e.getMessage()));
        } catch (Throwable t) {
            // Firebase is not configured in this build - the foreground service keeps working.
            Log.i(TAG, "Firebase unavailable: " + t.getMessage());
        }
    }

    static void onToken(Context context, @Nullable String token) {
        if (TextUtils.isEmpty(token)) {
            return;
        }
        boolean changed = !token.equals(Prefs.getPushToken(context));
        Prefs.setPushToken(context, token);
        if (changed) {
            registerAll(context);
        }
    }

    /** (Re)registers every vehicle the user left online. */
    public static void registerAll(Context context) {
        Context app = context.getApplicationContext();
        if (!isConfigured(app)) {
            return;
        }
        List<String> online = Prefs.getOnline(app);
        for (String plate : online) {
            register(app, plate);
        }
    }

    public static void register(Context context, String plate) {
        post(context.getApplicationContext(), "register", plate);
    }

    public static void unregister(Context context, String plate) {
        post(context.getApplicationContext(), "unregister", plate);
    }

    /**
     * Tells the wake-up server which PeerJS id this vehicle is answering on right now.
     *
     * <p>The peer normally registers under the plate itself, but when the broker still holds a
     * stale socket for that id the app takes a random one. Publishing it means the call page
     * always knows where to dial, instead of ringing an id that nobody is listening on.</p>
     */
    public static void publishPeer(Context context, String plate, String peerId) {
        final Context app = context.getApplicationContext();
        final String cleanPlate = CallService.sanitize(plate);
        final String cleanPeer = cleanPeerId(peerId);
        if (cleanPlate.isEmpty()) {
            return;
        }
        Prefs.setPeerId(app, cleanPlate, cleanPeer);
        final String token = Prefs.getPushToken(app);
        final String base = Prefs.getServerUrl(app);
        if (TextUtils.isEmpty(token) || TextUtils.isEmpty(base)) {
            return;
        }
        IO.execute(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("plate", cleanPlate);
                body.put("token", token);
                body.put("peerId", cleanPeer);
                send(base, "peer", body);
            } catch (Exception e) {
                Log.w(TAG, "peer publish failed: " + e.getMessage());
            }
        });
    }

    /** PeerJS ids are plain identifiers - keep it that way before sending anything anywhere. */
    private static String cleanPeerId(@Nullable String value) {
        if (value == null) {
            return "";
        }
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < value.length() && builder.length() < 64; i++) {
            char c = value.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '-' || c == '_';
            if (ok) {
                builder.append(c);
            }
        }
        return builder.toString();
    }

    /** Blocking HTTPS POST of a JSON body. Runs on the IO executor only. */
    private static void send(String base, String path, JSONObject body) throws Exception {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(base.endsWith("/") ? base + path : base + "/" + path);
            if (!"https".equalsIgnoreCase(url.getProtocol())) {
                return;
            }
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(10000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) {
                Log.w(TAG, path + " failed with HTTP " + code);
            }
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static void post(final Context app, final String path, final String plate) {
        final String token = Prefs.getPushToken(app);
        final String base = Prefs.getServerUrl(app);
        if (TextUtils.isEmpty(token) || TextUtils.isEmpty(base) || TextUtils.isEmpty(plate)) {
            return;
        }
        IO.execute(() -> {
            HttpURLConnection connection = null;
            try {
                JSONObject body = new JSONObject();
                body.put("plate", plate);
                body.put("token", token);
                body.put("platform", "android");

                URL url = new URL(base.endsWith("/") ? base + path : base + "/" + path);
                if (!"https".equalsIgnoreCase(url.getProtocol())) {
                    return;
                }
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(10000);
                connection.setReadTimeout(10000);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");

                byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(payload);
                }
                int code = connection.getResponseCode();
                if (code >= 200 && code < 300) {
                    if ("register".equals(path)) {
                        Prefs.setPushRegistered(app, plate, true);
                    } else {
                        Prefs.setPushRegistered(app, plate, false);
                    }
                } else {
                    Log.w(TAG, path + " failed with HTTP " + code);
                }
            } catch (Exception e) {
                Log.w(TAG, path + " failed: " + e.getMessage());
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
        });
    }
}
