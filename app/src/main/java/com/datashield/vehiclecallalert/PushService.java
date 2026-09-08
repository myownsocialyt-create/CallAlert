package com.datashield.vehiclecallalert;

import android.util.Log;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Receives the "somebody is calling this vehicle" push. A high priority data message wakes the
 * app even in Doze and gives it a short window in which a foreground service may be started,
 * which is exactly what {@link CallService} needs to accept the call.
 *
 * <p>If the push arrives late (the phone had no internet while the caller was ringing) the app
 * shows a missed-call notification instead of trying to connect.</p>
 */
public class PushService extends FirebaseMessagingService {

    private static final String TAG = "PushService";

    /** Pushes older than this are treated as a missed call. */
    private static final long STALE_AFTER_MS = 90_000L;

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        PushRegistrar.onToken(this, token);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> data = message.getData();
        if (data.isEmpty()) {
            return;
        }

        String type = data.get("type");
        String plate = CallService.sanitize(data.get("plate"));
        if (plate.isEmpty()) {
            return;
        }

        long sentAt = parseLong(data.get("ts"), message.getSentTime());
        long age = sentAt > 0 ? System.currentTimeMillis() - sentAt : 0L;

        if ("cancel".equals(type)) {
            CallService.missedCall(this, plate);
            return;
        }
        if (!"ring".equals(type)) {
            return;
        }

        if (age > STALE_AFTER_MS) {
            Log.i(TAG, "Ring for " + plate + " arrived " + (age / 1000) + "s late");
            CallService.missedCall(this, plate);
            return;
        }

        CallService.wake(this, plate);
    }

    private static long parseLong(String value, long fallback) {
        if (value == null) {
            return fallback;
        }
        try {
            return Long.parseLong(value.trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }
}
