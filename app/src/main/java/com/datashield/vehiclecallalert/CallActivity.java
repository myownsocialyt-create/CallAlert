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
import android.view.animation.AccelerateDecelerateInterpolator;
import android.widget.ImageButton;
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
    private TextView subtitleView;
    private TextView timerView;
    private TextView muteLabel;
    private TextView speakerLabel;
    private LinearLayout incomingActions;
    private LinearLayout activeActions;
    private ImageButton muteButton;
    private ImageButton speakerButton;
    private View pulseOne;
    private View pulseTwo;
    private boolean pulsing;

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
        subtitleView = findViewById(R.id.callSubtitle);
        timerView = findViewById(R.id.callTimer);
        muteLabel = findViewById(R.id.muteLabel);
        speakerLabel = findViewById(R.id.speakerLabel);
        incomingActions = findViewById(R.id.incomingActions);
        activeActions = findViewById(R.id.activeActions);
        muteButton = findViewById(R.id.muteButton);
        speakerButton = findViewById(R.id.speakerButton);
        pulseOne = findViewById(R.id.pulseOne);
        pulseTwo = findViewById(R.id.pulseTwo);

        findViewById(R.id.acceptButton).setOnClickListener(v ->
                CallService.simpleAction(this, CallService.ACTION_ACCEPT));
        findViewById(R.id.declineButton).setOnClickListener(v ->
                CallService.simpleAction(this, CallService.ACTION_DECLINE));
        findViewById(R.id.hangupButton).setOnClickListener(v ->
                CallService.simpleAction(this, CallService.ACTION_HANGUP));

        muteButton.setOnClickListener(v -> {
            boolean next = !muteButton.isSelected();
            applyMuteUi(next);
            CallService.flagAction(this, CallService.ACTION_MUTE, next);
        });

        speakerButton.setOnClickListener(v -> {
            boolean speakerOn = !speakerButton.isSelected();
            applySpeakerUi(speakerOn);
            CallService.flagAction(this, CallService.ACTION_SPEAKER, speakerOn);
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                moveTaskToBack(true);
            }
        });
    }

    private void applyMuteUi(boolean muted) {
        muteButton.setSelected(muted);
        muteButton.setImageResource(muted ? R.drawable.ic_mic_off : R.drawable.ic_mic_on);
        muteButton.setContentDescription(getString(muted ? R.string.action_unmute : R.string.action_mute));
        muteLabel.setText(muted ? R.string.action_unmute : R.string.action_mute);
    }

    private void applySpeakerUi(boolean speakerOn) {
        speakerButton.setSelected(speakerOn);
        speakerButton.setImageResource(speakerOn ? R.drawable.ic_speaker_on : R.drawable.ic_speaker_off);
        speakerButton.setContentDescription(
                getString(speakerOn ? R.string.action_speaker_on : R.string.action_speaker_off));
        speakerLabel.setText(speakerOn ? R.string.action_speaker_on : R.string.action_speaker_off);
    }

    /** Soft "radar" rings behind the vehicle avatar while the call is ringing or connecting. */
    private void startPulse() {
        if (pulsing) {
            return;
        }
        pulsing = true;
        pulseOne.setVisibility(View.VISIBLE);
        pulseTwo.setVisibility(View.VISIBLE);
        animatePulse(pulseOne, 0L);
        animatePulse(pulseTwo, 900L);
    }

    private void animatePulse(final View view, long delay) {
        if (!pulsing) {
            return;
        }
        view.setScaleX(0.65f);
        view.setScaleY(0.65f);
        view.setAlpha(0.9f);
        view.animate()
                .scaleX(1f).scaleY(1f).alpha(0f)
                .setStartDelay(delay)
                .setDuration(1800L)
                .setInterpolator(new AccelerateDecelerateInterpolator())
                .withEndAction(() -> animatePulse(view, 0L))
                .start();
    }

    private void stopPulse() {
        pulsing = false;
        pulseOne.animate().cancel();
        pulseTwo.animate().cancel();
        pulseOne.setVisibility(View.INVISIBLE);
        pulseTwo.setVisibility(View.INVISIBLE);
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
        stopPulse();
        super.onStop();
    }

    @Override
    public void onCallStateChanged(@NonNull CallBus.Snapshot snapshot) {
        plateView.setText(snapshot.number);
        startedAt = snapshot.startedAt;

        applyMuteUi(snapshot.muted);
        applySpeakerUi(snapshot.speakerOn);

        switch (snapshot.state) {
            case CallBus.STATE_INCOMING:
                statusView.setText(R.string.call_incoming);
                subtitleView.setText(R.string.call_privacy_note);
                incomingActions.setVisibility(View.VISIBLE);
                activeActions.setVisibility(View.GONE);
                timerView.setVisibility(View.GONE);
                startPulse();
                break;
            case CallBus.STATE_DIALING:
                statusView.setText(snapshot.message.isEmpty()
                        ? getString(R.string.call_connecting) : snapshot.message);
                subtitleView.setText(R.string.call_outgoing_note);
                incomingActions.setVisibility(View.GONE);
                activeActions.setVisibility(View.VISIBLE);
                timerView.setVisibility(View.GONE);
                startPulse();
                break;
            case CallBus.STATE_ACTIVE:
                statusView.setText(R.string.call_connected);
                subtitleView.setText(R.string.call_hd_note);
                incomingActions.setVisibility(View.GONE);
                activeActions.setVisibility(View.VISIBLE);
                timerView.setVisibility(View.VISIBLE);
                stopPulse();
                break;
            default:
                statusView.setText(snapshot.message.isEmpty()
                        ? getString(R.string.call_ended) : snapshot.message);
                subtitleView.setText("");
                incomingActions.setVisibility(View.GONE);
                activeActions.setVisibility(View.GONE);
                timerView.setVisibility(View.GONE);
                stopPulse();
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
