package com.datashield.vehiclecallalert;

import android.os.Handler;
import android.os.Looper;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Tiny in-process event bus that keeps the current call state and notifies the
 * activities (main UI and the full screen call screen) about changes.
 */
public final class CallBus {

    public static final String STATE_IDLE = "idle";
    public static final String STATE_INCOMING = "incoming";
    public static final String STATE_DIALING = "dialing";
    public static final String STATE_ACTIVE = "active";
    public static final String STATE_ENDED = "ended";

    public interface Listener {
        void onCallStateChanged(@NonNull Snapshot snapshot);

        /** Presence / stored data changed (online vehicles, call log, ...). */
        void onDataChanged();
    }

    public static final class Snapshot {
        public final String state;
        public final String number;
        public final String direction;
        public final String message;
        public final long startedAt;
        public final boolean muted;
        public final boolean speakerOn;

        Snapshot(String state, String number, String direction, String message,
                 long startedAt, boolean muted, boolean speakerOn) {
            this.state = state;
            this.number = number == null ? "" : number;
            this.direction = direction == null ? "" : direction;
            this.message = message == null ? "" : message;
            this.startedAt = startedAt;
            this.muted = muted;
            this.speakerOn = speakerOn;
        }

        public boolean isActive() {
            return STATE_ACTIVE.equals(state);
        }

        public boolean isIdle() {
            return STATE_IDLE.equals(state) || STATE_ENDED.equals(state);
        }
    }

    private static final CallBus INSTANCE = new CallBus();

    private final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    private final Handler main = new Handler(Looper.getMainLooper());

    private Snapshot snapshot = new Snapshot(STATE_IDLE, "", "", "", 0L, false, true);

    private CallBus() {
    }

    public static CallBus get() {
        return INSTANCE;
    }

    public void addListener(@NonNull Listener listener) {
        listeners.addIfAbsent(listener);
        final Snapshot current = snapshot;
        main.post(() -> listener.onCallStateChanged(current));
    }

    public void removeListener(@Nullable Listener listener) {
        if (listener != null) {
            listeners.remove(listener);
        }
    }

    @NonNull
    public Snapshot snapshot() {
        return snapshot;
    }

    void update(String state, String number, String direction, String message,
                long startedAt, boolean muted, boolean speakerOn) {
        snapshot = new Snapshot(state, number, direction, message, startedAt, muted, speakerOn);
        final Snapshot current = snapshot;
        main.post(() -> {
            for (Listener listener : listeners) {
                listener.onCallStateChanged(current);
            }
        });
    }

    void notifyDataChanged() {
        main.post(() -> {
            for (Listener listener : listeners) {
                listener.onDataChanged();
            }
        });
    }

    @NonNull
    JSONObject snapshotJson() {
        JSONObject json = new JSONObject();
        Snapshot current = snapshot;
        try {
            json.put("state", current.state);
            json.put("number", current.number);
            json.put("direction", current.direction);
            json.put("message", current.message);
            json.put("startedAt", current.startedAt);
            json.put("muted", current.muted);
            json.put("speakerOn", current.speakerOn);
        } catch (JSONException ignored) {
            // ignore
        }
        return json;
    }
}
