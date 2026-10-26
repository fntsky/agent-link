package dev.dshremote.app

/**
 * DSH appends a runtime-context footer to some user messages before commit.
 * Strip that suffix for display, but keep occurrences quoted inside fenced or
 * inline code so the user can still discuss the raw text.
 */
internal fun stripRuntimeContext(text: String): String {
    val markers = listOf(
        "Time sampled while preparing",
        "Browser time zone for this request:",
        "Elapsed since the preceding model-visible message:",
        "Current runtime context. This snapshot",
    )
    var cut = text.length
    for (marker in markers) {
        var from = 0
        while (true) {
            val index = text.indexOf(marker, from)
            if (index < 0) break
            val before = text.substring(0, index)
            if (before.count { it == '`' } % 2 == 0) {
                cut = minOf(cut, index)
                break
            }
            from = index + marker.length
        }
    }
    val result = text.substring(0, cut).trimEnd()
    return if (result.startsWith("Current runtime context.")) "" else result
}
