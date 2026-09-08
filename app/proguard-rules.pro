# Keep the JavaScript bridge that the bundled web UI talks to.
-keep class com.datashield.vehiclecallalert.WebAppBridge { *; }
-keepclassmembers class com.datashield.vehiclecallalert.WebAppBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
-keepattributes *Annotation*

# Useful stack traces for Play Console crash reports.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
