package com.comb.winter.core;

import com.comb.winter.net.WinterNet;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.server.level.ServerPlayer;

/** Pushes the four numbers to the owning client ~2×/second, no more. */
public final class WinterStatsSync {
    private WinterStatsSync() {}

    public static void push(ServerPlayer player, WinterStats s) {
        if (player.tickCount % 10 != 0) return;
        FriendlyByteBuf buf = new FriendlyByteBuf(io.netty.buffer.Unpooled.buffer());
        buf.writeDouble(s.cold);
        buf.writeDouble(s.warmth);
        buf.writeDouble(s.bodyTemp);
        buf.writeDouble(s.wetness);
        ServerPlayNetworking.send(player, WinterNet.STATS, buf);
    }
}
