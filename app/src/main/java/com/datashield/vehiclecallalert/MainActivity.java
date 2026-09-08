package com.datashield.vehiclecallalert;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;

/**
 * Hosts the bundled web UI (garage, QR code, windshield card, history, settings).
 *
 * Presence and calls live in {@link CallService}; this activity only sends commands and
 * renders the state that comes back through {@link CallBus}.
 */
public class MainActivity extends AppCompatActivity implements CallBus.Listener {

    private static final String APP_DOMAIN = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + APP_DOMAIN + "/assets/www/index.html";

    private static final int PENDING_NONE = 0;
    private static final int PENDING_ONLINE = 1;
    private static final int PENDING_CALL = 2;

    private WebView webView;
    private View errorView;
    private WebViewAssetLoader assetLoader;

    private ActivityResultLauncher<String> micPermissionLauncher;
    private ActivityResultLauncher<String> notificationPermissionLauncher;

    private int pendingAction = PENDING_NONE;
    private String pendingNumber = "";

    private int insetTopPx = 0;
    private int insetBottomPx = 0;
    private boolean pageReady = false;

    /** Sent by the missed-call notification: open the app and ring that vehicle back. */
    public static final String ACTION_CALL_BACK = "com.datashield.vehiclecallalert.CALL_BACK";

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        errorView = findViewById(R.id.errorView);
        Button retryButton = findViewById(R.id.retryButton);
        retryButton.setOnClickListener(v -> {
            errorView.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
            webView.loadUrl(START_URL);
        });

        micPermissionLauncher = registerForActivityResult(
                new ActivityResultContracts.RequestPermission(), this::onMicPermissionResult);
        notificationPermissionLauncher = registerForActivityResult(
                new ActivityResultContracts.RequestPermission(), granted -> {
                    if (!granted) {
                        Toast.makeText(this, R.string.notification_permission_needed, Toast.LENGTH_LONG).show();
                    }
                    continuePendingAction();
                });

        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(APP_DOMAIN)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        configureWebView();
        applyInsetsListener();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(START_URL);
        }

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                webView.evaluateJavascript(
                        "(function(){return window.onNativeBack ? !!window.onNativeBack() : false;})();",
                        value -> {
                            if ("true".equals(value)) {
                                return;
                            }
                            if (webView.canGoBack()) {
                                webView.goBack();
                            } else {
                                finish();
                            }
                        });
            }
        });

        // Vehicles that were left online must come back online when the app is opened.
        if (!Prefs.getOnline(this).isEmpty()) {
            CallService.sync(this);
        }

        PushRegistrar.refreshToken(this);
        handleCallBackIntent(getIntent());
    }

    @Override
    protected void onNewIntent(@NonNull Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleCallBackIntent(intent);
    }

    private void handleCallBackIntent(@Nullable Intent intent) {
        if (intent == null || !ACTION_CALL_BACK.equals(intent.getAction())) {
            return;
        }
        String number = CallService.sanitize(intent.getStringExtra(CallService.EXTRA_NUMBER));
        intent.setAction(null);
        if (!number.isEmpty()) {
            requestCall(number);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setGeolocationEnabled(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setTextZoom(100);

        webView.setBackgroundColor(ContextCompat.getColor(this, R.color.app_background));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView.addJavascriptInterface(new WebAppBridge(this), "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) {
                    return false;
                }
                if (APP_DOMAIN.equals(uri.getHost())) {
                    return false;
                }
                return openExternally(uri);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                pushInsetsToWeb();
                pushStateToWeb();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    webView.setVisibility(View.GONE);
                    errorView.setVisibility(View.VISIBLE);
                }
            }
        });
    }

    private boolean openExternally(@NonNull Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        switch (scheme) {
            case "http":
            case "https":
            case "mailto":
            case "tel":
            case "sms":
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(intent);
                } catch (ActivityNotFoundException e) {
                    Toast.makeText(this, R.string.no_app_to_handle, Toast.LENGTH_SHORT).show();
                }
                return true;
            default:
                return true;
        }
    }

    /* ------------------------------------------------------------------ web <-> native */

    String stateJsonWithEnvironment() {
        try {
            JSONObject state = new JSONObject(Prefs.stateJson(this));
            JSONObject env = new JSONObject();
            env.put("app", true);
            env.put("mic", hasMicPermission());
            env.put("notifications", hasNotificationPermission());
            env.put("batteryUnrestricted", isIgnoringBatteryOptimizations());
            env.put("push", PushRegistrar.isConfigured(this));
            env.put("pushServer", !Prefs.getServerUrl(this).isEmpty());
            state.put("env", env);
            return state.toString();
        } catch (JSONException e) {
            return Prefs.stateJson(this);
        }
    }

    void pushStateToWeb() {
        if (!pageReady || webView == null) {
            return;
        }
        String json = stateJsonWithEnvironment().replace("\\", "\\\\").replace("'", "\\'");
        webView.evaluateJavascript("if(window.onNativeState){window.onNativeState('" + json + "');}", null);
    }

    void requestGoOnline(String number) {
        if (!hasMicPermission()) {
            pendingAction = PENDING_ONLINE;
            pendingNumber = number;
            askForMicrophone();
            return;
        }
        if (!hasNotificationPermission()) {
            pendingAction = PENDING_ONLINE;
            pendingNumber = number;
            askForNotifications();
            return;
        }
        CallService.goOnline(this, number);
        pushStateToWeb();
    }

    void requestCall(String number) {
        if (!hasMicPermission()) {
            pendingAction = PENDING_CALL;
            pendingNumber = number;
            askForMicrophone();
            return;
        }
        CallService.placeCall(this, number);
    }

    void requestCallPermissions() {
        if (!hasMicPermission()) {
            pendingAction = PENDING_NONE;
            askForMicrophone();
        } else if (!hasNotificationPermission()) {
            askForNotifications();
        } else {
            Toast.makeText(this, R.string.permissions_ready, Toast.LENGTH_SHORT).show();
        }
    }

    private void askForMicrophone() {
        if (ActivityCompat.shouldShowRequestPermissionRationale(this, Manifest.permission.RECORD_AUDIO)) {
            new AlertDialog.Builder(this)
                    .setTitle(R.string.app_name)
                    .setMessage(R.string.mic_permission_rationale)
                    .setPositiveButton(android.R.string.ok,
                            (dialog, which) -> micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO))
                    .setNegativeButton(android.R.string.cancel, (dialog, which) -> clearPending())
                    .setOnCancelListener(dialog -> clearPending())
                    .show();
        } else {
            micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO);
        }
    }

    private void askForNotifications() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS);
        } else {
            continuePendingAction();
        }
    }

    private void onMicPermissionResult(boolean granted) {
        if (!granted) {
            clearPending();
            Toast.makeText(this, R.string.mic_permission_denied, Toast.LENGTH_LONG).show();
            pushStateToWeb();
            return;
        }
        if (pendingAction == PENDING_ONLINE && !hasNotificationPermission()) {
            askForNotifications();
            return;
        }
        continuePendingAction();
    }

    private void continuePendingAction() {
        int action = pendingAction;
        String number = pendingNumber;
        clearPending();

        if (action == PENDING_ONLINE && !number.isEmpty()) {
            CallService.goOnline(this, number);
        } else if (action == PENDING_CALL && !number.isEmpty()) {
            CallService.placeCall(this, number);
        }
        pushStateToWeb();
    }

    private void clearPending() {
        pendingAction = PENDING_NONE;
        pendingNumber = "";
    }

    private boolean hasMicPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return true;
        }
        return ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean isIgnoringBatteryOptimizations() {
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        return power != null && power.isIgnoringBatteryOptimizations(getPackageName());
    }

    /* ------------------------------------------------------------------ CallBus */

    @Override
    public void onCallStateChanged(@NonNull CallBus.Snapshot snapshot) {
        pushStateToWeb();
    }

    @Override
    public void onDataChanged() {
        pushStateToWeb();
    }

    /* ------------------------------------------------------------------ insets */

    private void applyInsetsListener() {
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.root), (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            insetTopPx = bars.top;
            insetBottomPx = Math.max(bars.bottom, ime.bottom);
            v.setPadding(bars.left, 0, bars.right, 0);
            pushInsetsToWeb();
            return windowInsets;
        });
    }

    private void pushInsetsToWeb() {
        if (!pageReady || webView == null) {
            return;
        }
        float density = getResources().getDisplayMetrics().density;
        if (density <= 0f) {
            density = 1f;
        }
        int top = Math.round(insetTopPx / density);
        int bottom = Math.round(insetBottomPx / density);
        webView.evaluateJavascript(
                "if(window.applyNativeInsets){window.applyNativeInsets(" + top + "," + bottom + ");}", null);
    }

    /* ------------------------------------------------------------------ lifecycle */

    @Override
    protected void onStart() {
        super.onStart();
        CallBus.get().addListener(this);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
        pushStateToWeb();
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onStop() {
        CallBus.get().removeListener(this);
        super.onStop();
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) {
                parent.removeView(webView);
            }
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
