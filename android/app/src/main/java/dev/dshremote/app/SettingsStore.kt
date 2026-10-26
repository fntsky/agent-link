package dev.dshremote.app

import android.content.Context

enum class ThemeMode { SYSTEM, LIGHT, DARK }
enum class AccentPalette { TEAL, BLUE, PURPLE, ORANGE }

data class AppSettings(
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val palette: AccentPalette = AccentPalette.TEAL,
    val fontScale: Float = 1f,
    val remoteAddress: String = "",
)

class SettingsStore(context: Context) {
    private val prefs = context.getSharedPreferences("dsh_remote_settings", Context.MODE_PRIVATE)

    fun load(): AppSettings = AppSettings(
        themeMode = runCatching {
            ThemeMode.valueOf(prefs.getString("theme_mode", ThemeMode.SYSTEM.name).orEmpty())
        }.getOrDefault(ThemeMode.SYSTEM),
        palette = runCatching {
            AccentPalette.valueOf(prefs.getString("palette", AccentPalette.TEAL.name).orEmpty())
        }.getOrDefault(AccentPalette.TEAL),
        fontScale = prefs.getFloat("font_scale", 1f).coerceIn(0.85f, 1.4f),
        remoteAddress = prefs.getString("remote_address", "").orEmpty(),
    )

    fun save(settings: AppSettings) {
        prefs.edit()
            .putString("theme_mode", settings.themeMode.name)
            .putString("palette", settings.palette.name)
            .putFloat("font_scale", settings.fontScale)
            .putString("remote_address", settings.remoteAddress)
            .apply()
    }
}
