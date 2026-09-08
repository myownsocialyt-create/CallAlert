package com.datashield.vehiclecallalert;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Brings the vehicles that the user left online back online after a reboot or an app update,
 * so "online" really means online until the user taps "Go offline".
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) {
            return;
        }
        switch (intent.getAction()) {
            case Intent.ACTION_BOOT_COMPLETED:
            case Intent.ACTION_LOCKED_BOOT_COMPLETED:
            case Intent.ACTION_MY_PACKAGE_REPLACED:
            case "android.intent.action.QUICKBOOT_POWERON":
                if (Prefs.getOnline(context).isEmpty()) {
                    break;
                }
                if (PushRegistrar.isConfigured(context)) {
                    // Push mode needs no connection at all - just make sure the wake-up
                    // server still has a valid token for this device.
                    PushRegistrar.refreshToken(context);
                    PushRegistrar.registerAll(context);
                } else {
                    CallService.sync(context);
                }
                break;
            default:
                break;
        }
    }
}
