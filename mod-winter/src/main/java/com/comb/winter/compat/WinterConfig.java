package com.comb.winter.compat;

/**
 * A tiny config with the switches the spec implies ("if it hurts FPS, cut the
 * visuals"). Read from winter.properties next to the mod jar; written with
 * defaults on first launch.
 */
public final class WinterConfig {
    private WinterConfig() {}

    public static boolean whiteLeaves() { return value("white_leaves", true); }
    public static boolean longNights() { return value("long_nights", true); }
    public static boolean heavyFog() { return value("heavy_fog", true); }
    public static boolean particles() { return value("particles", true); }
    public static boolean footprints() { return value("footprints", true); }

    private static final java.util.Map<String, Boolean> CACHE = new java.util.HashMap<>();

    private static boolean value(String key, boolean fallback) {
        return CACHE.computeIfAbsent(key, k -> {
            java.nio.file.Path file = java.nio.file.Path.of("config", "winter.properties");
            try {
                if (!java.nio.file.Files.exists(file)) {
                    java.nio.file.Files.createDirectories(file.getParent());
                    java.nio.file.Files.writeString(file,
                            "white_leaves=true\nlong_nights=true\nheavy_fog=true\nparticles=true\nfootprints=true\n");
                    return fallback;
                }
                for (String line : java.nio.file.Files.readAllLines(file)) {
                    String trimmed = line.trim();
                    if (trimmed.startsWith(k + "=")) return Boolean.parseBoolean(trimmed.substring(k.length() + 1).trim());
                }
            } catch (Exception ignored) {
                // config is a convenience, never a reason not to start
            }
            return fallback;
        });
    }
}
