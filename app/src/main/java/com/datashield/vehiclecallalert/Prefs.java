package com.datashield.vehiclecallalert;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Single source of truth for the app data (vehicles, call log, online vehicles, settings).
 * Both the web UI and the background {@link CallService} read and write it.
 */
public final class Prefs {

    private static final String FILE = "vca_store";
    private static final String K_VEHICLES = "vehicles";
    private static final String K_LOGS = "logs";
    private static final String K_ONLINE = "online";
    private static final String K_SETTINGS = "settings";
    private static final String K_PUSH_TOKEN = "push_token";
    private static final String K_PUSH_PLATES = "push_plates";
    private static final String K_LINK = "link";
    private static final int MAX_LOGS = 100;

    /**
     * Wake-up server used when the user has not entered one. Saving an empty value in the
     * settings screen switches instant wake-up off and falls back to the foreground service.
     */
    public static final String DEFAULT_SERVER = "https://vehicle-alert.techeditz8.workers.dev";

    private Prefs() {
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    /* ----------------------------------------------------------------- vehicles */

    public static JSONArray getVehicles(Context context) {
        return readArray(context, K_VEHICLES);
    }

    public static void setVehicles(Context context, String json) {
        writeArray(context, K_VEHICLES, json);
    }

    /* ----------------------------------------------------------------- logs */

    public static JSONArray getLogs(Context context) {
        return readArray(context, K_LOGS);
    }

    public static void addLog(Context context, String number, String direction, String status, long durationSeconds) {
        try {
            JSONObject entry = new JSONObject();
            entry.put("number", number);
            entry.put("direction", direction);
            entry.put("status", status);
            entry.put("duration", durationSeconds);
            entry.put("ts", System.currentTimeMillis());

            JSONArray existing = getLogs(context);
            JSONArray updated = new JSONArray();
            updated.put(entry);
            for (int i = 0; i < existing.length() && updated.length() < MAX_LOGS; i++) {
                updated.put(existing.get(i));
            }
            prefs(context).edit().putString(K_LOGS, updated.toString()).apply();
        } catch (JSONException ignored) {
            // never happens with plain values
        }
    }

    public static void clearLogs(Context context) {
        prefs(context).edit().putString(K_LOGS, "[]").apply();
    }

    /* ----------------------------------------------------------------- online vehicles */

    public static List<String> getOnline(Context context) {
        List<String> result = new ArrayList<>();
        JSONArray array = readArray(context, K_ONLINE);
        for (int i = 0; i < array.length(); i++) {
            String value = array.optString(i, "");
            if (!value.isEmpty() && !result.contains(value)) {
                result.add(value);
            }
        }
        return result;
    }

    public static boolean isOnline(Context context, String number) {
        return getOnline(context).contains(number);
    }

    public static void setOnline(Context context, String number, boolean online) {
        List<String> current = getOnline(context);
        if (online) {
            if (!current.contains(number)) {
                current.add(number);
            }
        } else {
            current.remove(number);
        }
        prefs(context).edit().putString(K_ONLINE, new JSONArray(current).toString()).apply();
    }

    public static void clearOnline(Context context) {
        prefs(context).edit().putString(K_ONLINE, "[]").apply();
    }

    /* ----------------------------------------------------------------- settings */

    public static JSONObject getSettings(Context context) {
        String raw = prefs(context).getString(K_SETTINGS, "{}");
        try {
            return new JSONObject(raw == null ? "{}" : raw);
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    public static void setSettings(Context context, String json) {
        try {
            new JSONObject(json); // validate
            prefs(context).edit().putString(K_SETTINGS, json).apply();
        } catch (JSONException ignored) {
            // keep the previous value when the payload is malformed
        }
    }

    /** Wake-up server that turns a scanned QR code into a push message. */
    public static String getServerUrl(Context context) {
        String url = getSettings(context).optString("server", DEFAULT_SERVER).trim();
        if (url.endsWith("/")) {
            url = url.substring(0, url.length() - 1);
        }
        return url.startsWith("https://") ? url : "";
    }

    /* ----------------------------------------------------------------- push */

    public static String getPushToken(Context context) {
        return prefs(context).getString(K_PUSH_TOKEN, "");
    }

    public static void setPushToken(Context context, String token) {
        prefs(context).edit().putString(K_PUSH_TOKEN, token == null ? "" : token).apply();
    }

    /** Vehicles the wake-up server currently knows about. */
    public static List<String> getPushRegistered(Context context) {
        List<String> result = new ArrayList<>();
        JSONArray array = readArray(context, K_PUSH_PLATES);
        for (int i = 0; i < array.length(); i++) {
            String value = array.optString(i, "");
            if (!value.isEmpty()) {
                result.add(value);
            }
        }
        return result;
    }

    public static void setPushRegistered(Context context, String plate, boolean registered) {
        List<String> plates = getPushRegistered(context);
        if (registered && !plates.contains(plate)) {
            plates.add(plate);
        } else if (!registered) {
            plates.remove(plate);
        } else {
            return;
        }
        writeArray(context, K_PUSH_PLATES, new JSONArray(plates).toString());
    }

    /* ----------------------------------------------------------------- link diagnostics */

    /**
     * Live connection state per vehicle: which peer id the vehicle is currently reachable on
     * and the last error the signalling layer reported. Shown on the diagnostics screen so a
     * user can tell "not set up" from "cannot reach the network" without a cable.
     */
    public static JSONObject getLinkState(Context context) {
        String raw = prefs(context).getString(K_LINK, "{}");
        try {
            return new JSONObject(raw == null ? "{}" : raw);
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    public static void setPeerId(Context context, String plate, String peerId) {
        writeLink(context, plate, "peer", peerId == null ? "" : peerId, true);
    }

    public static void setPeerError(Context context, String plate, String type) {
        writeLink(context, plate, "err", type == null ? "" : type, false);
    }

    private static void writeLink(Context context, String plate, String key, String value,
                                  boolean clearError) {
        if (plate == null || plate.isEmpty()) {
            return;
        }
        try {
            JSONObject all = getLinkState(context);
            JSONObject entry = all.optJSONObject(plate);
            if (entry == null) {
                entry = new JSONObject();
            }
            entry.put(key, value);
            entry.put("ts", System.currentTimeMillis());
            if (clearError && !value.isEmpty()) {
                entry.put("err", "");
            }
            all.put(plate, entry);
            prefs(context).edit().putString(K_LINK, all.toString()).apply();
        } catch (JSONException ignored) {
            // never happens with plain values
        }
    }

    /* ----------------------------------------------------------------- misc */

    /** Full state snapshot handed to the web UI. */
    public static String stateJson(Context context) {
        JSONObject state = new JSONObject();
        try {
            state.put("vehicles", getVehicles(context));
            state.put("logs", getLogs(context));
            state.put("online", new JSONArray(getOnline(context)));
            state.put("settings", getSettings(context));
            state.put("call", CallBus.get().snapshotJson());
            state.put("link", getLinkState(context));
            state.put("pushToken", !getPushToken(context).isEmpty());
            state.put("registered", new JSONArray(getPushRegistered(context)));
        } catch (JSONException ignored) {
            // ignore
        }
        return state.toString();
    }

    public static void wipe(Context context) {
        prefs(context).edit().clear().apply();
    }

    private static JSONArray readArray(Context context, String key) {
        String raw = prefs(context).getString(key, "[]");
        try {
            return new JSONArray(raw == null ? "[]" : raw);
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    private static void writeArray(Context context, String key, String json) {
        try {
            new JSONArray(json); // validate
            prefs(context).edit().putString(key, json).apply();
        } catch (JSONException ignored) {
            // keep the previous value when the payload is malformed
        }
    }
}
