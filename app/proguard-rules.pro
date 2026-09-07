# Keep WebView JS interfaces
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
-keepattributes *Annotation*

# PeerJS / WebRTC
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**

# Gson if used
-keep class com.google.gson.** { *; }
