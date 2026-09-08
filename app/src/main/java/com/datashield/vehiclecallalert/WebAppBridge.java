package com.datashield.vehiclecallalert;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.print.PrintHelper;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.util.Locale;

/**
 * Bridge exposed to the bundled web UI (and only to it — the WebView never navigates away
 * from the app assets). The UI keeps no calling logic of its own: presence and calls are
 * handled by {@link CallService} so they survive the app being closed.
 */
public class WebAppBridge {

    private static final String SHARE_DIR = "shared";

    private final WeakReference<MainActivity> activityRef;

    WebAppBridge(MainActivity activity) {
        this.activityRef = new WeakReference<>(activity);
    }

    private MainActivity activity() {
        return activityRef.get();
    }

    /* ------------------------------------------------------------------ state */

    @JavascriptInterface
    public String getState() {
        MainActivity activity = activity();
        if (activity == null) {
            return "{}";
        }
        return activity.stateJsonWithEnvironment();
    }

    @JavascriptInterface
    public void saveVehicles(String json) {
        MainActivity activity = activity();
        if (activity == null || json == null) {
            return;
        }
        Prefs.setVehicles(activity, json);
    }

    @JavascriptInterface
    public void saveSettings(String json) {
        MainActivity activity = activity();
        if (activity == null || json == null) {
            return;
        }
        Prefs.setSettings(activity, json);
    }

    @JavascriptInterface
    public void clearLogs() {
        MainActivity activity = activity();
        if (activity == null) {
            return;
        }
        Prefs.clearLogs(activity);
        activity.pushStateToWeb();
    }

    @JavascriptInterface
    public void wipeData() {
        MainActivity activity = activity();
        if (activity == null) {
            return;
        }
        CallService.goOfflineAll(activity);
        Prefs.wipe(activity);
        activity.pushStateToWeb();
    }

    /* ------------------------------------------------------------------ presence + calls */

    @JavascriptInterface
    public void goOnline(final String number) {
        final MainActivity activity = activity();
        final String plate = CallService.sanitize(number);
        if (activity == null || plate.isEmpty()) {
            return;
        }
        activity.runOnUiThread(() -> activity.requestGoOnline(plate));
    }

    @JavascriptInterface
    public void goOffline(final String number) {
        final MainActivity activity = activity();
        final String plate = CallService.sanitize(number);
        if (activity == null || plate.isEmpty()) {
            return;
        }
        activity.runOnUiThread(() -> {
            CallService.goOffline(activity, plate);
            activity.pushStateToWeb();
        });
    }

    @JavascriptInterface
    public void startCall(final String number) {
        final MainActivity activity = activity();
        final String plate = CallService.sanitize(number);
        if (activity == null || plate.isEmpty()) {
            return;
        }
        activity.runOnUiThread(() -> activity.requestCall(plate));
    }

    /* ------------------------------------------------------------------ export */

    @JavascriptInterface
    public void shareText(final String text) {
        final MainActivity activity = activity();
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

    /** Writes a base64 payload into the app cache and opens the Android share sheet. */
    @JavascriptInterface
    public void shareFile(final String base64Data, final String mimeType, final String fileName) {
        final MainActivity activity = activity();
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

    /** Sends a generated image (QR code or windshield card) to the Android print service. */
    @JavascriptInterface
    public void printImage(final String base64Data, final String jobName) {
        final MainActivity activity = activity();
        if (activity == null || base64Data == null) {
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
                Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bitmap == null) {
                    throw new IOException("decode");
                }
                PrintHelper helper = new PrintHelper(activity);
                helper.setScaleMode(PrintHelper.SCALE_MODE_FIT);
                helper.setOrientation(bitmap.getWidth() >= bitmap.getHeight()
                        ? PrintHelper.ORIENTATION_LANDSCAPE : PrintHelper.ORIENTATION_PORTRAIT);
                String name = jobName == null || jobName.trim().isEmpty()
                        ? activity.getString(R.string.print_job_name) : jobName;
                helper.printBitmap(name, bitmap);
            } catch (Exception e) {
                Toast.makeText(activity, R.string.print_failed, Toast.LENGTH_SHORT).show();
            }
        });
    }

    /* ------------------------------------------------------------------ system settings */

    @JavascriptInterface
    public void openBatterySettings() {
        final MainActivity activity = activity();
        if (activity == null) {
            return;
        }
        activity.runOnUiThread(() -> {
            Intent intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            try {
                activity.startActivity(intent);
            } catch (ActivityNotFoundException e) {
                openAppSettings();
            }
        });
    }

    @JavascriptInterface
    public void openNotificationSettings() {
        final MainActivity activity = activity();
        if (activity == null) {
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName());
                activity.startActivity(intent);
            } catch (ActivityNotFoundException e) {
                openAppSettings();
            }
        });
    }

    @JavascriptInterface
    public void openAppSettings() {
        final MainActivity activity = activity();
        if (activity == null) {
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", activity.getPackageName(), null));
                activity.startActivity(intent);
            } catch (ActivityNotFoundException ignored) {
                // nothing else we can do
            }
        });
    }

    @JavascriptInterface
    public void requestPermissions() {
        final MainActivity activity = activity();
        if (activity == null) {
            return;
        }
        activity.runOnUiThread(activity::requestCallPermissions);
    }

    @JavascriptInterface
    public void showToast(final String message) {
        final MainActivity activity = activity();
        if (activity == null || message == null) {
            return;
        }
        activity.runOnUiThread(() -> Toast.makeText(activity, message, Toast.LENGTH_SHORT).show());
    }

    @JavascriptInterface
    public int sdkInt() {
        return Build.VERSION.SDK_INT;
    }

    /* ------------------------------------------------------------------ helpers */

    private static void startChooser(MainActivity activity, Intent intent) {
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
