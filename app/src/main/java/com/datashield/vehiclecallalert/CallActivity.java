package com.datashield.vehiclecallalert;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

import java.util.Locale;

/**
 * Full screen call UI. It is shown for incoming calls (through the full screen intent of the
 * incoming-call notification, so it also appears above the lock screen) and for outgoing calls.
 */
public class CallActivity extends AppCompatActivity implements CallBus.Listener {

    private static final String EXTRA_INCOMING = "incoming";

    private TextView plateView;
    private TextView statusView;
    private TextView timerView;
    private LinearLayout incomingActions;
    private LinearLayout activeActions;
    private Button muteButton;
    private Button speakerButton;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private long startedAt;
    private boolean finishing;

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            if (startedAt > 0) {
                long seconds = (System.currentTimeMillis() - startedAt) / 1000L;
                timerView.setText(String.format(Locale.US, "%02d:%02d", seconds / 60, seconds % 60));
            }
            handler.postDelayed(this, 1000L);
        }
    };

    public static Intent intent(Context context, boolean incoming) {
        return new Intent(context, CallActivity.class)
                .putExtra(EXTRA_INCOMING, incoming)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    }

    public static void show(Context context, boolean incoming) {
        try {
            context.startActivity(intent(context, incoming));
        } catch (Exception ignored) {
            // Background activity starts can be blocked; the full screen notification covers that.
        }
    }

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        showOverLockScreen();
        setContentView(R.layout.activity_call);

        plateView = findViewById(R.id.callPlate);
        statusView = findViewById(R.id.callStatus);
        timerView = findViewById(R.id.callTimer);
        incomingActions = findViewById(R.id.incomingActions);
        activeActions = findViewById(R.id.activeActions);
        muteButton = findViewById(R.id.muteButton);
        speakerButton = findViewById(R.id.speakerButton);

        findViewById(R.id.acceptButton).setOnClickListener(v ->
                CallService.simpleAction(this, CallService.ACTION_ACCEPT));
        findViewById(R.id.declineButton).setOnClickListener(v ->
                CallService.simpleAction(this, CallService.ACTION_DECLINE));
        findViewById(R.id.hangupButton).setOnClickListener(v ->
                CallService.simpleAction(this, CallService.ACTION_HANGUP));

        muteButton.setOnClickListener(v -> {
            boolean next = !muteButton.isSelected();
            muteButton.setSelected(next);
            muteButton.setText(next ? R.string.action_unmute : R.string.action_mute);
            CallService.flagAction(this, CallService.ACTION_MUTE, next);
        });

        speakerButton.setOnClickListener(v -> {
            boolean speakerOn = !speakerButton.isSelected();
            speakerButton.setSelected(speakerOn);
            speakerButton.setText(speakerOn ? R.string.action_speaker_on : R.string.action_speaker_off);
            CallService.flagAction(this, CallService.ACTION_SPEAKER, speakerOn);
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                moveTaskToBack(true);
            }
        });
    }

    private void showOverLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
            KeyguardManager keyguard = getSystemService(KeyguardManager.class);
            if (keyguard != null) {
                keyguard.requestDismissKeyguard(this, null);
            }
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override
    protected void onStart() {
        super.onStart();
        CallBus.get().addListener(this);
        handler.post(ticker);
    }

    @Override
    protected void onStop() {
        CallBus.get().removeListener(this);
        handler.removeCallbacks(ticker);
        super.onStop();
    }

    @Override
    public void onCallStateChanged(@NonNull CallBus.Snapshot snapshot) {
        plateView.setText(snapshot.number);
        startedAt = snapshot.startedAt;

        muteButton.setSelected(snapshot.muted);
        muteButton.setText(snapshot.muted ? R.string.action_unmute : R.string.action_mute);
        speakerButton.setSelected(snapshot.speakerOn);
        speakerButton.setText(snapshot.speakerOn ? R.string.action_speaker_on : R.string.action_speaker_off);

        switch (snapshot.state) {
            case CallBus.STATE_INCOMING:
                statusView.setText(R.string.call_incoming);
                incomingActions.setVisibility(View.VISIBLE);
                activeActions.setVisibility(View.GONE);
                timerView.setVisibility(View.GONE);
                break;
            case CallBus.STATE_DIALING:
                statusView.setText(snapshot.message.isEmpty()
                        ? getString(R.string.call_connecting) : snapshot.message);
                incomingActions.setVisibility(View.GONE);
                activeActions.setVisibility(View.VISIBLE);
                timerView.setVisibility(View.GONE);
                break;
            case CallBus.STATE_ACTIVE:
                statusView.setText(R.string.call_connected);
                incomingActions.setVisibility(View.GONE);
                activeActions.setVisibility(View.VISIBLE);
                timerView.setVisibility(View.VISIBLE);
                break;
            default:
                statusView.setText(snapshot.message.isEmpty()
                        ? getString(R.string.call_ended) : snapshot.message);
                incomingActions.setVisibility(View.GONE);
                activeActions.setVisibility(View.GONE);
                if (!finishing) {
                    finishing = true;
                    handler.postDelayed(this::finishAndRemoveTask, 1200L);
                }
                break;
        }
    }

    @Override
    public void onDataChanged() {
        // nothing to do here
    }
}
