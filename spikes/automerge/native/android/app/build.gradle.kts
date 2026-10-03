plugins {
    id("com.android.application")
}

android {
    namespace = "creative.cooking.automerge.spike"
    compileSdk = 36

    defaultConfig {
        applicationId = "creative.cooking.automerge.spike"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.0.0-spike"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets {
        getByName("androidTest").java.srcDir("../../java/src/main/java")
    }
}

dependencies {
    implementation("org.automerge:automerge:0.0.9")
    implementation("org.automerge:androidnative:0.0.9")

    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
}
