package com.comb.winter.core;

/**
 * The four numbers the whole mod hangs on, per player.
 *
 * Kept as a plain mutable object so the ticker can do the arithmetic the spec
 * spells out (per second, multiplied by shelter, wetness, clothes) without any
 * of it hiding in a dozen listeners.
 */
public final class WinterStats {
    /** 0..100 — how cold the player is. 75 hurts, 100 freezes. */
    public double cold;
    /** 0..100 — how much warmth they are carrying. 0 doubles the cold gain. */
    public double warmth = 50;
    /** 30..40 °C — core body temperature, starts at 37. */
    public double bodyTemp = 37;
    /** 0..100 — soaked through, makes everything worse until dried. */
    public double wetness;

    /** seconds of respawn buffer left (spec §12.2) */
    public int respawnGrace;
    /** seconds left of artifact immunity (§6 winter_heart) */
    public int coldImmunity;
    /** seconds of "baby it's cold outside" accumulated in a storm, for illnesses */
    public int stormExposure;
    /** wet-dry hysteresis so a player does not flicker between states */
    public boolean isWet() { return wetness >= 40; }

    public void clamp() {
        cold = Math.max(0, Math.min(100, cold));
        warmth = Math.max(0, Math.min(100, warmth));
        wetness = Math.max(0, Math.min(100, wetness));
        bodyTemp = Math.max(29.5, Math.min(37.5, bodyTemp));
    }

    /** everything back to normal — used on respawn and by /winter reset */
    public void reset() {
        cold = 0;
        warmth = 50;
        bodyTemp = 37;
        wetness = 0;
        stormExposure = 0;
        coldImmunity = 0;
        respawnGrace = 10;
    }

    public int coldPercent() { return (int) Math.round(cold); }
    public int warmthPercent() { return (int) Math.round(warmth); }
    public int wetPercent() { return (int) Math.round(wetness); }
}
