package com.comb.winter.weather;

import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.Level;

/**
 * Global side of the weather: chat warnings, drift growth, and the quiet parts
 * (wind gusts for sound, snow accumulation for the visuals).
 */
public final class WeatherTicker {
    private WeatherTicker() {}

    private static long lastWarnedCycle = -1;
    private static int driftTimer = 0;

    public static void tick(MinecraftServer server) {
        long time = server.overworld().getGameTime();

        // §2 predictability: one warning per front cycle, not a message every tick
        long cycle = Math.floorDiv(time, 12000L);
        if (cycle != lastWarnedCycle && time % 400 == 0) {
            WeatherState next = WeatherFront.sample(server.overworld(), server.overworld().getSharedSpawnPos());
            if (next.stormIntensity > 0.35) {
                lastWarnedCycle = cycle;
                for (ServerPlayer p : server.getPlayerList().getPlayers()) {
                    p.sendSystemMessage(Component.translatable("winter.chat.front", 10));
                }
            }
        }

        // §2 drifts: one layer every five minutes on the leeward side
        if (++driftTimer >= 20 * 300) {
            driftTimer = 0;
            for (ServerPlayer p : server.getPlayerList().getPlayers()) {
                com.comb.winter.snow.SnowPhysics.addDrift(p);
            }
        }
    }
}
