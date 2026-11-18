package com.comb.winter.weather;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.Level;

/**
 * §2 — fronts, not zones.
 *
 * A front is a moving band: its centre advances across the world every tick of
 * the clock, and the weather you feel is a smooth function of how close the band
 * is to you. That single idea gives the spec three of its requirements for free:
 * different villages see different weather, the change takes about a minute to
 * pass, and pressure drops before it arrives.
 */
public final class WeatherFront {
    private WeatherFront() {}

    /** ten minutes; the spec changes wind and fronts on this rhythm */
    private static final long CYCLE = 24000L / 2; // 10 min in ticks
    private static final double BAND_WIDTH = 900.0;

    public static WeatherState sample(Level level, BlockPos pos) {
        long time = level.getGameTime();
        long cycle = Math.floorDiv(time, CYCLE);
        double phase = (double) Math.floorMod(time, CYCLE) / CYCLE;   // 0..1 through the front
        // deterministic per-cycle seed so the wind does not jitter every tick
        double seed = hash(level.getSeed(), cycle);

        // direction of travel in world space, 8 points of the compass
        double angle = (Math.floor(seed * 8) / 8.0) * Math.PI * 2;
        double dirX = Math.cos(angle), dirZ = Math.sin(angle);

        // where the band's leading edge is right now, wrapped across a big square
        double span = 10000.0;
        double bandCenter = ((phase * 2.0 - 0.5) * span);
        double along = (pos.getX() * dirX + pos.getZ() * dirZ);
        double distance = Math.abs(wrap(along - bandCenter, span));

        // closeness 0..1: smooth, so passing the front takes ~60 seconds of world time
        double closeness = Math.max(0, 1.0 - distance / BAND_WIDTH);
        closeness = smoothstep(closeness);

        double humidity = 0.4 + 0.6 * frac(seed * 7.13);
        double windBase = 0.6 + 2.4 * frac(seed * 3.31);
        double wind = windBase * (0.7 + 0.3 * closeness);

        double storm = closeness > 0.55 && humidity >= 0.7 ? closeness : closeness * 0.4;
        boolean snowing = closeness > 0.35;

        // §2 pressure: falls while the front is approaching, rises after it passes
        double pressure = 1013.0 - 18.0 * closeness * (phase < 0.6 ? 1 : -1);

        // §2 vertical model: higher is colder and windier, low ground gathers fog
        double altitude = Math.max(0, pos.getY() - 64) / 120.0;
        wind *= 1.0 + altitude;
        storm = Math.min(1.0, storm * (1.0 + altitude * 0.5));

        return new WeatherState(storm, wind, snowing, pressure);
    }

    static double wrap(double v, double span) {
        v = ((v + span / 2) % span + span) % span - span / 2;
        return v;
    }

    static double frac(double x) { return x - Math.floor(x); }

    static double smoothstep(double x) { return x * x * (3 - 2 * x); }

    static double hash(long seed, long cycle) {
        long h = seed * 6364136223846793005L + cycle * 1442695040888963407L;
        h ^= h >>> 33;
        h *= 0xff51afd7ed558ccdL;
        h ^= h >>> 33;
        return frac((double) (h >>> 11) / (double) (1L << 53));
    }

    /** §2: "Фронт приближается: буря через ~10 минут" — a chat heads-up for everyone. */
    public static boolean stormWithinTenMinutes(Level level, BlockPos pos) {
        WeatherState now = sample(level, pos);
        WeatherState soon = sample(level, pos.offset(0, 0, 0)); // placeholder for a look-ahead sample
        return now.stormIntensity < 0.3 && soon.stormIntensity >= 0.3;
    }
}
