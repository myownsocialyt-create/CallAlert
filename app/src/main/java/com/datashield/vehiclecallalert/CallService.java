package com.datashield.vehiclecallalert;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.text.TextUtils;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.content.ContextCompat;
import androidx.webkit.WebViewAssetLoader;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Keeps the vehicle reachable in the background.
 *
 * The service owns a head-less WebView running {@code presence.html}: that page holds the
 * PeerJS connections for every vehicle that is online, answers incoming calls and places
 * outgoing ones. Because it lives in a foreground service, the connection survives the app
 * being minimised, the screen being off or the launcher activity being closed, and it is
 * restored automatically after a reboot ({@link BootReceiver}).
 */
public class CallService extends Service {

    /* ------------------------------------------------------------------ intent API */

    public static final String ACTION_SYNC = "com.datashield.vehiclecallalert.SYNC";
    public static final String ACTION_GO_ONLINE = "com.datashield.vehiclecallalert.GO_ONLINE";
    public static final String ACTION_GO_OFFLINE = "com.datashield.vehiclecallalert.GO_OFFLINE";
    public static final String ACTION_GO_OFFLINE_ALL = "com.datashield.vehiclecallalert.GO_OFFLINE_ALL";
    public static final String ACTION_CALL = "com.datashield.vehiclecallalert.CALL";
    public static final String ACTION_ACCEPT = "com.datashield.vehiclecallalert.ACCEPT";
    public static final String ACTION_DECLINE = "com.datashield.vehiclecallalert.DECLINE";
    public static final String ACTION_HANGUP = "com.datashield.vehiclecallalert.HANGUP";
    public static final String ACTION_MUTE = "com.datashield.vehiclecallalert.MUTE";
    public static final String ACTION_SPEAKER = "com.datashield.vehiclecallalert.SPEAKER";
    /** Sent by {@link PushService}: a caller is trying to reach this vehicle right now. */
    public static final String ACTION_WAKE = "com.datashield.vehiclecallalert.WAKE";
    /** Sent by {@link PushService}: a call attempt that could not be delivered in time. */
    public static final String ACTION_MISSED = "com.datashield.vehiclecallalert.MISSED";

    public static final String EXTRA_NUMBER = "number";
    public static final String EXTRA_FLAG = "flag";

    private static final String CH_PRESENCE = "presence";
    private static final String CH_INCOMING = "incoming_call";
    private static final String CH_ONGOING = "ongoing_call";
    private static final String CH_MISSED = "missed_call";

    private static final int ID_PRESENCE = 1001;
    private static final int ID_INCOMING = 1002;
    private static final int ID_MISSED_BASE = 2000;

    /** How long the service stays awake after a push before giving up on the call. */
    private static final long WAKE_WINDOW_MS = 75_000L;
    private static final long RING_TIMEOUT_MS = 45_000L;
    private static final String PRESENCE_URL =
            "https://appassets.androidplatform.net/assets/www/presence.html";

    /* ------------------------------------------------------------------ state */

    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<String> pendingJs = new ArrayList<>();

    private WebView presenceView;
    private WebViewAssetLoader assetLoader;
    private boolean presenceReady;
    private boolean started;

    private String callState = CallBus.STATE_IDLE;
    private String callNumber = "";
    private String callDirection = "";
    private long callStartedAt;
    private boolean muted;
    private boolean speakerOn = true;
    private boolean connectionLost;
    /** While a push wake-up window is open the service stays alive waiting for the call. */
    private long wakeUntilElapsed;

    private Ringtone ringtone;
    private Vibrator vibrator;
    private AudioFocusRequest focusRequest;
    private PowerManager.WakeLock wakeLock;
    private ConnectivityManager.NetworkCallback networkCallback;

    private final Runnable ringTimeout = () -> {
        if (CallBus.STATE_INCOMING.equals(callState)) {
            sendJs("Presence.decline()");
            onCallEnded(callNumber, "incoming", "Missed", 0);
        } else if (CallBus.STATE_DIALING.equals(callState)) {
            sendJs("Presence.hangup()");
            onCallEnded(callNumber, "outgoing", "No answer", 0);
        }
    };

    /* ------------------------------------------------------------------ static helpers */

    public static void sync(Context context) {
        send(context, new Intent(context, CallService.class).setAction(ACTION_SYNC));
    }

    public static void goOnline(Context context, String number) {
        send(context, new Intent(context, CallService.class)
                .setAction(ACTION_GO_ONLINE).putExtra(EXTRA_NUMBER, number));
    }

    public static void goOffline(Context context, String number) {
        send(context, new Intent(context, CallService.class)
                .setAction(ACTION_GO_OFFLINE).putExtra(EXTRA_NUMBER, number));
    }

    public static void goOfflineAll(Context context) {
        send(context, new Intent(context, CallService.class).setAction(ACTION_GO_OFFLINE_ALL));
    }

    /** Comes online for a few seconds so the caller's PeerJS call can arrive. */
    public static void wake(Context context, String number) {
        send(context, new Intent(context, CallService.class)
                .setAction(ACTION_WAKE).putExtra(EXTRA_NUMBER, number));
    }

    /** Records a call attempt that arrived too late to be answered. */
    public static void missedCall(Context context, String number) {
        send(context, new Intent(context, CallService.class)
                .setAction(ACTION_MISSED).putExtra(EXTRA_NUMBER, number));
    }

    public static void placeCall(Context context, String number) {
        send(context, new Intent(context, CallService.class)
                .setAction(ACTION_CALL).putExtra(EXTRA_NUMBER, number));
    }

    public static void simpleAction(Context context, String action) {
        send(context, new Intent(context, CallService.class).setAction(action));
    }

    public static void flagAction(Context context, String action, boolean flag) {
        send(context, new Intent(context, CallService.class)
                .setAction(action).putExtra(EXTRA_FLAG, flag));
    }

    private static void send(Context context, Intent intent) {
        try {
            ContextCompat.startForegroundService(context.getApplicationContext(), intent);
        } catch (Exception e) {
            // Background start restrictions: nothing else we can do here.
        }
    }

    /* ------------------------------------------------------------------ lifecycle */

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        createPresenceView();
        registerNetworkCallback();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        startForegroundSafely();

        String action = intent == null ? ACTION_SYNC : intent.getAction();
        String number = intent == null ? null : sanitize(intent.getStringExtra(EXTRA_NUMBER));
        boolean flag = intent != null && intent.getBooleanExtra(EXTRA_FLAG, false);

        if (action == null) {
            action = ACTION_SYNC;
        }

        switch (action) {
            case ACTION_GO_ONLINE:
                if (!TextUtils.isEmpty(number)) {
                    Prefs.setOnline(this, number, true);
                    if (PushRegistrar.isConfigured(this)) {
                        // Push mode: the wake-up server keeps the vehicle reachable, no socket needed.
                        PushRegistrar.register(this, number);
                    } else {
                        sendJs("Presence.goOnline('" + number + "')");
                    }
                    CallBus.get().notifyDataChanged();
                }
                break;
            case ACTION_GO_OFFLINE:
                if (!TextUtils.isEmpty(number)) {
                    Prefs.setOnline(this, number, false);
                    PushRegistrar.unregister(this, number);
                    sendJs("Presence.goOffline('" + number + "')");
                    CallBus.get().notifyDataChanged();
                }
                break;
            case ACTION_GO_OFFLINE_ALL:
                for (String plate : Prefs.getOnline(this)) {
                    PushRegistrar.unregister(this, plate);
                }
                Prefs.clearOnline(this);
                sendJs("Presence.goOfflineAll()");
                CallBus.get().notifyDataChanged();
                break;
            case ACTION_WAKE:
                if (!TextUtils.isEmpty(number)) {
                    wakeUntilElapsed = SystemClock.elapsedRealtime() + WAKE_WINDOW_MS;
                    if (!Prefs.isOnline(this, number)) {
                        // The vehicle was switched off in the meantime.
                        Prefs.setOnline(this, number, false);
                        PushRegistrar.unregister(this, number);
                    } else {
                        sendJs("Presence.goOnline('" + number + "')");
                        main.postDelayed(this::stopIfIdle, WAKE_WINDOW_MS + 1000L);
                    }
                }
                break;
            case ACTION_MISSED:
                if (!TextUtils.isEmpty(number)) {
                    Prefs.addLog(this, number, "incoming", "Missed (phone offline)", 0);
                    showMissedCallNotification(number, "Missed (phone offline)");
                    CallBus.get().notifyDataChanged();
                }
                break;
            case ACTION_CALL:
                if (!TextUtils.isEmpty(number)) {
                    startOutgoing(number);
                }
                break;
            case ACTION_ACCEPT:
                acceptCall();
                break;
            case ACTION_DECLINE:
                declineCall();
                break;
            case ACTION_HANGUP:
                hangUp();
                break;
            case ACTION_MUTE:
                muted = flag;
                sendJs("Presence.setMute(" + flag + ")");
                publishState();
                break;
            case ACTION_SPEAKER:
                speakerOn = flag;
                applySpeaker();
                publishState();
                break;
            case ACTION_SYNC:
            default:
                syncOnlineVehicles();
                break;
        }

        updatePresenceNotification();
        stopIfIdle();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopRinging();
        releaseAudio();
        unregisterNetworkCallback();
        if (presenceView != null) {
            presenceView.destroy();
            presenceView = null;
        }
        CallBus.get().update(CallBus.STATE_IDLE, "", "", "", 0L, false, true);
        super.onDestroy();
    }

    /* ------------------------------------------------------------------ presence WebView */

    private void createPresenceView() {
        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain("appassets.androidplatform.net")
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        WebView view = new WebView(this);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        view.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                boolean audio = false;
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                        audio = true;
                    }
                }
                if (audio && hasMicPermission()) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    request.deny();
                }
            }
        });

        view.addJavascriptInterface(new PresenceBridge(), "NativePresence");
        view.loadUrl(PRESENCE_URL);
        presenceView = view;
    }

    private void sendJs(final String script) {
        main.post(() -> {
            if (presenceView == null) {
                return;
            }
            if (!presenceReady) {
                pendingJs.add(script);
                return;
            }
            presenceView.evaluateJavascript(script, null);
        });
    }

    private void flushPendingJs() {
        if (presenceView == null) {
            return;
        }
        for (String script : pendingJs) {
            presenceView.evaluateJavascript(script, null);
        }
        pendingJs.clear();
    }

    private void syncOnlineVehicles() {
        if (PushRegistrar.isConfigured(this)) {
            PushRegistrar.registerAll(this);
            return;
        }
        for (String number : Prefs.getOnline(this)) {
            sendJs("Presence.goOnline('" + number + "')");
        }
    }

    /* ------------------------------------------------------------------ call handling */

    private void startOutgoing(String number) {
        if (!CallBus.STATE_IDLE.equals(callState) && !CallBus.STATE_ENDED.equals(callState)) {
            return;
        }
        callState = CallBus.STATE_DIALING;
        callNumber = number;
        callDirection = "outgoing";
        callStartedAt = 0L;
        muted = false;
        speakerOn = true;
        connectionLost = false;

        acquireAudio();
        publishState();
        CallActivity.show(this, false);
        sendJs("Presence.call('" + number + "')");
        main.removeCallbacks(ringTimeout);
        main.postDelayed(ringTimeout, RING_TIMEOUT_MS);
        updatePresenceNotification();
    }

    private void acceptCall() {
        if (!CallBus.STATE_INCOMING.equals(callState)) {
            return;
        }
        stopRinging();
        NotificationManagerCompat.from(this).cancel(ID_INCOMING);
        acquireAudio();
        CallActivity.show(this, false);
        sendJs("Presence.accept()");
        publishState();
    }

    private void declineCall() {
        if (CallBus.STATE_INCOMING.equals(callState)) {
            sendJs("Presence.decline()");
            onCallEnded(callNumber, "incoming", "Declined", 0);
        } else {
            hangUp();
        }
    }

    private void hangUp() {
        if (CallBus.STATE_IDLE.equals(callState)) {
            return;
        }
        sendJs("Presence.hangup()");
        long seconds = callStartedAt > 0 ? (System.currentTimeMillis() - callStartedAt) / 1000L : 0L;
        onCallEnded(callNumber, callDirection, callStartedAt > 0 ? "Answered" : "Cancelled", seconds);
    }

    private void onCallEnded(String number, String direction, String status, long seconds) {
        main.removeCallbacks(ringTimeout);
        stopRinging();
        NotificationManagerCompat.from(this).cancel(ID_INCOMING);

        if (!TextUtils.isEmpty(number)) {
            Prefs.addLog(this, number, direction, status, seconds);
            if ("Missed".equals(status) || "Missed (no internet)".equals(status)) {
                showMissedCallNotification(number, status);
            }
        }

        callState = CallBus.STATE_ENDED;
        String message = status;
        publishState(message);

        callState = CallBus.STATE_IDLE;
        callNumber = "";
        callDirection = "";
        callStartedAt = 0L;
        muted = false;
        connectionLost = false;
        releaseAudio();

        main.postDelayed(() -> {
            publishState();
            CallBus.get().notifyDataChanged();
            updatePresenceNotification();
            stopIfIdle();
        }, 900L);
    }

    private void publishState() {
        publishState("");
    }

    private void publishState(String message) {
        CallBus.get().update(callState, callNumber, callDirection, message, callStartedAt, muted, speakerOn);
    }

    /* ------------------------------------------------------------------ JS -> native */

    private final class PresenceBridge {

        @android.webkit.JavascriptInterface
        public void ready() {
            main.post(() -> {
                presenceReady = true;
                flushPendingJs();
                syncOnlineVehicles();
            });
        }

        @android.webkit.JavascriptInterface
        public void online(String number) {
            main.post(() -> {
                CallBus.get().notifyDataChanged();
                updatePresenceNotification();
            });
        }

        @android.webkit.JavascriptInterface
        public void offline(String number) {
            main.post(() -> {
                CallBus.get().notifyDataChanged();
                updatePresenceNotification();
            });
        }

        @android.webkit.JavascriptInterface
        public void error(String number, String type, String message) {
            main.post(() -> {
                if ("unavailable-id".equals(type) && !TextUtils.isEmpty(number)) {
                    Prefs.setOnline(CallService.this, number, false);
                }
                CallBus.get().notifyDataChanged();
                updatePresenceNotification();
                if (!CallBus.STATE_IDLE.equals(callState) && !CallBus.STATE_ACTIVE.equals(callState)) {
                    String status = "peer-unavailable".equals(type) ? "Owner offline" : "Call failed";
                    onCallEnded(callNumber, callDirection, status, 0);
                }
            });
        }

        @android.webkit.JavascriptInterface
        public void incoming(String number) {
            final String plate = sanitize(number);
            main.post(() -> handleIncoming(plate));
        }

        @android.webkit.JavascriptInterface
        public void ringing(String number) {
            main.post(() -> {
                if (CallBus.STATE_DIALING.equals(callState)) {
                    publishState("Ringing");
                }
            });
        }

        @android.webkit.JavascriptInterface
        public void connected(String number) {
            main.post(() -> {
                main.removeCallbacks(ringTimeout);
                callState = CallBus.STATE_ACTIVE;
                callStartedAt = System.currentTimeMillis();
                stopRinging();
                acquireAudio();
                applySpeaker();
                publishState();
                updatePresenceNotification();
            });
        }

        @android.webkit.JavascriptInterface
        public void ended(String number, String direction, String status, int seconds) {
            final String plate = sanitize(number);
            final String dir = direction == null ? "" : direction;
            final String st = status == null ? "Ended" : status;
            main.post(() -> {
                if (CallBus.STATE_IDLE.equals(callState)) {
                    return;
                }
                onCallEnded(TextUtils.isEmpty(plate) ? callNumber : plate, dir, st, seconds);
            });
        }
    }

    private void handleIncoming(String number) {
        if (!CallBus.STATE_IDLE.equals(callState) && !CallBus.STATE_ENDED.equals(callState)) {
            sendJs("Presence.rejectBusy()");
            Prefs.addLog(this, number, "incoming", "Missed (busy)", 0);
            CallBus.get().notifyDataChanged();
            return;
        }

        callState = CallBus.STATE_INCOMING;
        callNumber = number;
        callDirection = "incoming";
        callStartedAt = 0L;
        muted = false;
        speakerOn = true;
        connectionLost = false;

        publishState();
        showIncomingNotification(number);
        startRinging();
        CallActivity.show(this, true);

        main.removeCallbacks(ringTimeout);
        main.postDelayed(ringTimeout, RING_TIMEOUT_MS);
    }

    /* ------------------------------------------------------------------ notifications */

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }

        NotificationChannel presence = new NotificationChannel(
                CH_PRESENCE, getString(R.string.channel_presence), NotificationManager.IMPORTANCE_LOW);
        presence.setDescription(getString(R.string.channel_presence_desc));
        presence.setShowBadge(false);
        manager.createNotificationChannel(presence);

        // The ringtone is played by the service itself so it can loop, therefore the
        // channel stays silent to avoid a double sound.
        NotificationChannel incoming = new NotificationChannel(
                CH_INCOMING, getString(R.string.channel_incoming), NotificationManager.IMPORTANCE_HIGH);
        incoming.setDescription(getString(R.string.channel_incoming_desc));
        incoming.setSound(null, null);
        incoming.enableVibration(false);
        incoming.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(incoming);

        NotificationChannel ongoing = new NotificationChannel(
                CH_ONGOING, getString(R.string.channel_ongoing), NotificationManager.IMPORTANCE_LOW);
        ongoing.setSound(null, null);
        manager.createNotificationChannel(ongoing);

        NotificationChannel missed = new NotificationChannel(
                CH_MISSED, getString(R.string.channel_missed), NotificationManager.IMPORTANCE_DEFAULT);
        missed.setDescription(getString(R.string.channel_missed_desc));
        manager.createNotificationChannel(missed);
    }

    private void startForegroundSafely() {
        Notification notification = buildPresenceNotification();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
                if (CallBus.STATE_ACTIVE.equals(callState) && hasMicPermission()) {
                    type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                }
                startForeground(ID_PRESENCE, notification, type);
            } else {
                // Below Android 14 the types declared in the manifest are used automatically.
                startForeground(ID_PRESENCE, notification);
            }
            started = true;
        } catch (Exception e) {
            try {
                startForeground(ID_PRESENCE, notification);
                started = true;
            } catch (Exception ignored) {
                // The service will be stopped by the system; nothing else to do.
            }
        }
    }

    private Notification buildPresenceNotification() {
        List<String> online = Prefs.getOnline(this);
        String title;
        String text;

        if (CallBus.STATE_ACTIVE.equals(callState)) {
            title = getString(R.string.notif_in_call);
            text = callNumber;
        } else if (online.isEmpty()) {
            title = getString(R.string.notif_standby);
            text = getString(R.string.notif_standby_desc);
        } else if (connectionLost) {
            title = getString(R.string.notif_reconnecting);
            text = TextUtils.join(", ", online);
        } else {
            title = getString(R.string.notif_online);
            text = getString(R.string.notif_online_desc, TextUtils.join(", ", online));
        }

        boolean inCall = !CallBus.STATE_IDLE.equals(callState) && !CallBus.STATE_ENDED.equals(callState);
        Intent target = inCall
                ? CallActivity.intent(this, CallBus.STATE_INCOMING.equals(callState))
                : new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent open = PendingIntent.getActivity(this, inCall ? 1 : 0, target,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CH_PRESENCE)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .setShowWhen(false)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE);

        if (!online.isEmpty() && !CallBus.STATE_ACTIVE.equals(callState)) {
            builder.addAction(0, getString(R.string.action_go_offline),
                    servicePendingIntent(ACTION_GO_OFFLINE_ALL, 10));
        }
        if (CallBus.STATE_ACTIVE.equals(callState)) {
            builder.addAction(0, getString(R.string.action_hang_up),
                    servicePendingIntent(ACTION_HANGUP, 11));
        }
        return builder.build();
    }

    private void updatePresenceNotification() {
        if (!started) {
            return;
        }
        NotificationManagerCompat manager = NotificationManagerCompat.from(this);
        if (ContextCompat.checkSelfPermission(this, "android.permission.POST_NOTIFICATIONS")
                != PackageManager.PERMISSION_GRANTED
                && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return;
        }
        manager.notify(ID_PRESENCE, buildPresenceNotification());
    }

    private void showIncomingNotification(String number) {
        PendingIntent fullScreen = PendingIntent.getActivity(this, 20,
                CallActivity.intent(this, true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Person caller = new Person.Builder()
                .setName(getString(R.string.notif_incoming_person, number))
                .setImportant(true)
                .build();

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CH_INCOMING)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.notif_incoming_title))
                .setContentText(getString(R.string.notif_incoming_text, number))
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setOngoing(true)
                .setAutoCancel(false)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setFullScreenIntent(fullScreen, true)
                .setContentIntent(fullScreen);

        try {
            builder.setStyle(NotificationCompat.CallStyle.forIncomingCall(caller,
                    servicePendingIntent(ACTION_DECLINE, 21),
                    servicePendingIntent(ACTION_ACCEPT, 22)));
        } catch (Throwable ignored) {
            builder.addAction(0, getString(R.string.action_decline), servicePendingIntent(ACTION_DECLINE, 21));
            builder.addAction(0, getString(R.string.action_accept), servicePendingIntent(ACTION_ACCEPT, 22));
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(this, "android.permission.POST_NOTIFICATIONS")
                != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        NotificationManagerCompat.from(this).notify(ID_INCOMING, builder.build());
    }

    private void showMissedCallNotification(String number, String status) {
        PendingIntent open = PendingIntent.getActivity(this, 30,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // Calling back needs a foreground activity (microphone + Play policy), so the action
        // opens the app with the number pre-loaded instead of dialling from the background.
        PendingIntent callBack = PendingIntent.getActivity(this,
                31 + Math.abs(number.hashCode() % 400),
                new Intent(this, MainActivity.class)
                        .setAction(MainActivity.ACTION_CALL_BACK)
                        .putExtra(EXTRA_NUMBER, number)
                        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CH_MISSED)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.notif_missed_title))
                .setContentText(getString(R.string.notif_missed_text, number))
                .setStyle(new NotificationCompat.BigTextStyle()
                        .bigText(getString(R.string.notif_missed_big, number, status)))
                .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
                .setAutoCancel(true)
                .setContentIntent(open)
                .addAction(0, getString(R.string.action_call_back), callBack);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(this, "android.permission.POST_NOTIFICATIONS")
                != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        NotificationManagerCompat.from(this)
                .notify(ID_MISSED_BASE + Math.abs(number.hashCode() % 500), builder.build());
    }

    private PendingIntent servicePendingIntent(String action, int requestCode) {
        Intent intent = new Intent(this, CallService.class).setAction(action);
        return PendingIntent.getService(this, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /* ------------------------------------------------------------------ ringing + audio */

    private void startRinging() {
        AudioManager audio = getSystemService(AudioManager.class);
        int ringerMode = audio == null ? AudioManager.RINGER_MODE_NORMAL : audio.getRingerMode();

        if (ringerMode != AudioManager.RINGER_MODE_SILENT) {
            vibrate();
        }
        if (ringerMode != AudioManager.RINGER_MODE_NORMAL) {
            return;
        }

        try {
            Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            if (uri == null) {
                uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            }
            ringtone = RingtoneManager.getRingtone(getApplicationContext(), uri);
            if (ringtone != null) {
                ringtone.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    ringtone.setLooping(true);
                }
                ringtone.play();
            }
        } catch (Exception ignored) {
            // ringtone is a nice-to-have
        }
    }

    private void vibrate() {
        try {
            if (vibrator == null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    VibratorManager manager = getSystemService(VibratorManager.class);
                    vibrator = manager == null ? null : manager.getDefaultVibrator();
                } else {
                    vibrator = getSystemService(Vibrator.class);
                }
            }
            if (vibrator == null || !vibrator.hasVibrator()) {
                return;
            }
            long[] pattern = {0, 700, 900};
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
            } else {
                vibrateLegacy(pattern);
            }
        } catch (Exception ignored) {
            // vibration is optional
        }
    }

    @SuppressWarnings("deprecation")
    private void vibrateLegacy(long[] pattern) {
        if (vibrator != null) {
            vibrator.vibrate(pattern, 0);
        }
    }

    private void stopRinging() {
        if (ringtone != null) {
            try {
                ringtone.stop();
            } catch (Exception ignored) {
                // ignore
            }
            ringtone = null;
        }
        if (vibrator != null) {
            try {
                vibrator.cancel();
            } catch (Exception ignored) {
                // ignore
            }
        }
    }

    private void acquireAudio() {
        AudioManager audio = getSystemService(AudioManager.class);
        if (audio == null) {
            return;
        }
        audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
        applySpeaker();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest == null) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build())
                    .build();
            audio.requestAudioFocus(focusRequest);
        }

        if (wakeLock == null) {
            PowerManager power = getSystemService(PowerManager.class);
            if (power != null) {
                wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,
                        "VehicleCallAlert::call");
                wakeLock.setReferenceCounted(false);
            }
        }
        if (wakeLock != null && !wakeLock.isHeld()) {
            wakeLock.acquire(60 * 60 * 1000L);
        }
    }

    private void applySpeaker() {
        AudioManager audio = getSystemService(AudioManager.class);
        if (audio == null) {
            return;
        }
        try {
            audio.setSpeakerphoneOn(speakerOn);
        } catch (Exception ignored) {
            // ignore
        }
    }

    private void releaseAudio() {
        AudioManager audio = getSystemService(AudioManager.class);
        if (audio != null) {
            try {
                audio.setSpeakerphoneOn(false);
                audio.setMode(AudioManager.MODE_NORMAL);
            } catch (Exception ignored) {
                // ignore
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) {
                audio.abandonAudioFocusRequest(focusRequest);
                focusRequest = null;
            }
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
    }

    /* ------------------------------------------------------------------ connectivity */

    private void registerNetworkCallback() {
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        if (manager == null) {
            return;
        }
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(@NonNull Network network) {
                main.post(() -> {
                    connectionLost = false;
                    sendJs("Presence.networkUp()");
                    updatePresenceNotification();
                });
            }

            @Override
            public void onLost(@NonNull Network network) {
                main.post(() -> {
                    connectionLost = true;
                    updatePresenceNotification();
                    if (CallBus.STATE_INCOMING.equals(callState)) {
                        sendJs("Presence.decline()");
                        onCallEnded(callNumber, "incoming", "Missed (no internet)", 0);
                    } else if (CallBus.STATE_DIALING.equals(callState) || CallBus.STATE_ACTIVE.equals(callState)) {
                        long seconds = callStartedAt > 0
                                ? (System.currentTimeMillis() - callStartedAt) / 1000L : 0L;
                        sendJs("Presence.hangup()");
                        onCallEnded(callNumber, callDirection, "Connection lost", seconds);
                    }
                });
            }
        };
        try {
            manager.registerDefaultNetworkCallback(networkCallback);
        } catch (Exception e) {
            networkCallback = null;
        }
    }

    private void unregisterNetworkCallback() {
        if (networkCallback == null) {
            return;
        }
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        if (manager != null) {
            try {
                manager.unregisterNetworkCallback(networkCallback);
            } catch (Exception ignored) {
                // ignore
            }
        }
        networkCallback = null;
    }

    /* ------------------------------------------------------------------ helpers */

    private boolean hasMicPermission() {
        return ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void stopIfIdle() {
        if (!CallBus.STATE_IDLE.equals(callState) && !CallBus.STATE_ENDED.equals(callState)) {
            return;
        }
        if (SystemClock.elapsedRealtime() < wakeUntilElapsed) {
            // Waiting for the call that the push message announced.
            return;
        }
        // Without push the service is the only thing keeping the vehicle reachable.
        if (!PushRegistrar.isConfigured(this) && !Prefs.getOnline(this).isEmpty()) {
            return;
        }
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
        started = false;
    }

    static String sanitize(@Nullable String value) {
        if (value == null) {
            return "";
        }
        String upper = value.toUpperCase(Locale.ROOT);
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < upper.length() && builder.length() < 20; i++) {
            char c = upper.charAt(i);
            if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
                builder.append(c);
            }
        }
        return builder.toString();
    }
}
