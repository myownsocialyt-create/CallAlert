package com.datashield.vehiclecallalert;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.net.Uri;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.util.Locale;

/**
 * Small bridge exposed to the bundled web UI (and only to it — the WebView never
 * navigates away from the app assets). It provides the few things a web page
 * cannot do on its own: sharing a generated file, call audio routing and
 * keeping the screen on during a call.
 */
public class WebAppBridge {

    private static final String SHARE_DIR = "shared";

    private final WeakReference<Activity> activityRef;

    WebAppBridge(Activity activity) {
        this.activityRef = new WeakReference<>(activity);
    }

    private Activity activity() {
        return activityRef.get();
    }

    @JavascriptInterface
    public void showToast(final String message) {
        final Activity activity = activity();
        if (activity == null || message == null) {
            return;
        }
        activity.runOnUiThread(() -> Toast.makeText(activity, message, Toast.LENGTH_SHORT).show());
    }

    @JavascriptInterface
    public void shareText(final String text) {
        final Activity activity = activity();
        if (activity == null || text == null) {
            return;
        }
        activity.runOnUiThread(() -> {
            Intent intent = new Intent(Intent.ACTION_SEND);
            intent.setType("text/plain");
            intent.putExtra(Intent.EXTRA_TEXT, text);
            startChooser(activity, intent);
        });
    }

    /**
     * Writes a base64 payload into the app cache and opens the Android share sheet,
     * so the user can save it to Files, Photos, Drive, WhatsApp, a printer, ...
     */
    @JavascriptInterface
    public void shareFile(final String base64Data, final String mimeType, final String fileName) {
        final Activity activity = activity();
        if (activity == null || base64Data == null) {
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
                File dir = new File(activity.getCacheDir(), SHARE_DIR);
                if (!dir.exists() && !dir.mkdirs()) {
                    throw new IOException("cache dir");
                }
                File file = new File(dir, safeFileName(fileName));
                try (OutputStream out = new FileOutputStream(file)) {
                    out.write(bytes);
                }

                Uri uri = FileProvider.getUriForFile(activity,
                        activity.getPackageName() + ".fileprovider", file);

                Intent intent = new Intent(Intent.ACTION_SEND);
                intent.setType(mimeType == null ? "application/octet-stream" : mimeType);
                intent.putExtra(Intent.EXTRA_STREAM, uri);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startChooser(activity, intent);
            } catch (Exception e) {
                Toast.makeText(activity, R.string.share_failed, Toast.LENGTH_SHORT).show();
            }
        });
    }

    @JavascriptInterface
    public void startCallAudio() {
        final Activity activity = activity();
        if (activity == null) {
            return;
        }
        activity.runOnUiThread(() -> {
            activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            AudioManager audio = audioManager(activity);
            if (audio != null) {
                audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
                audio.setSpeakerphoneOn(true);
            }
        });
    }

    @JavascriptInterface
    public void setSpeakerphone(final boolean on) {
        final Activity activity = activity();
        if (activity == null) {
            return;
        }
        activity.runOnUiThread(() -> {
            AudioManager audio = audioManager(activity);
            if (audio != null) {
                audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
                audio.setSpeakerphoneOn(on);
            }
        });
    }

    @JavascriptInterface
    public void stopCallAudio() {
        final Activity activity = activity();
        if (activity == null) {
            return;
        }
        activity.runOnUiThread(() -> {
            activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            AudioManager audio = audioManager(activity);
            if (audio != null) {
                audio.setSpeakerphoneOn(false);
                audio.setMode(AudioManager.MODE_NORMAL);
            }
        });
    }

    private static AudioManager audioManager(Context context) {
        return (AudioManager) context.getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
    }

    private static void startChooser(Activity activity, Intent intent) {
        try {
            Intent chooser = Intent.createChooser(intent, activity.getString(R.string.share_title));
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(chooser);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(activity, R.string.no_app_to_handle, Toast.LENGTH_SHORT).show();
        }
    }

    private static String safeFileName(String name) {
        String cleaned = name == null ? "" : name.trim().replaceAll("[^A-Za-z0-9._-]", "_");
        if (cleaned.isEmpty()) {
            cleaned = "vehicle-call-alert-" + System.currentTimeMillis();
        }
        return cleaned.toLowerCase(Locale.ROOT);
    }
}
