#!/usr/bin/env sh
# Minimal gradlew — will be replaced by full wrapper if you have Android Studio.
# For GitHub Actions, the workflow uses chmod +x and downloads Gradle via wrapper properties.
# If build fails, download official gradlew from https://github.com/gradle/gradle/raw/master/gradle/wrapper/gradle-wrapper.properties template

exec gradle wrapper --gradle-version 8.6 2>/dev/null || echo "Use Android Studio to generate gradlew, or run: gradle wrapper"
