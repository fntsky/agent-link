import com.google.protobuf.gradle.*
plugins {
    kotlin("jvm")
    id("com.google.protobuf")
    `java-library`
}
kotlin {
    jvmToolchain(21)
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}
java { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
sourceSets { main { proto { srcDir("../../proto") } } }
protobuf {
    protoc { artifact = "com.google.protobuf:protoc:4.29.3" }
    generateProtoTasks { all().configureEach { builtins { named("java") { option("lite") } } } }
}
dependencies {
    api("com.google.protobuf:protobuf-javalite:4.29.3")
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.bouncycastle:bcprov-jdk18on:1.79")
    testImplementation("junit:junit:4.13.2")
}
tasks.test {
    // Optional real Relay integration, exercised by tests/android_e2e.py.
    listOf("HRP_TEST_URL", "HRP_TEST_PAIRING_CODE", "HRP_TEST_RELAY_ID").forEach { name ->
        System.getenv(name)?.let { environment(name, it) }
    }
}
