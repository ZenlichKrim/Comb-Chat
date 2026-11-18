package com.comb.winter.net;

import com.comb.winter.WinterMod;
import io.netty.buffer.Unpooled;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;

/**
 * Two packets, both tiny: the per-player stats, and the weather snapshot the HUD
 * needs for its pressure arrow. Anything bigger goes through block entities.
 */
public final class WinterNet {
    private WinterNet() {}

    public static final ResourceLocation STATS_ID = WinterMod.id("stats");
    public static final ResourceLocation WEATHER_ID = WinterMod.id("weather");

    /** Simple payload wrapper so the same class works for both channels. */
    public record StatsPayload(byte[] data) implements CustomPacketPayload {
        public static final StreamCodec<FriendlyByteBuf, StatsPayload> CODEC = CustomPacketPayload.codec(
                (payload, buf) -> buf.writeBytes(payload.data),
                buf -> new StatsPayload(buf.readByteArray()));
        @Override public Type<? extends CustomPacketPayload> type() { return new Type<>(STATS_ID); }
    }

    public static CustomPacketPayload.Type<StatsPayload> STATS = new CustomPacketPayload.Type<>(STATS_ID);
    public static CustomPacketPayload.Type<StatsPayload> WEATHER = new CustomPacketPayload.Type<>(WEATHER_ID);

    public static void registerServer() {
        PayloadTypeRegistry.playS2C().register(STATS, StatsPayload.CODEC);
        PayloadTypeRegistry.playS2C().register(WEATHER, StatsPayload.CODEC);
    }

    public static void registerClient() {
        ClientPlayNetworking.registerGlobalReceiver(STATS, (payload, context) ->
                context.client().execute(() -> ClientStats.accept(payload.data())));
    }

    /** helper for the sync code: build the buffer once */
    public static FriendlyByteBuf buffer() {
        return new FriendlyByteBuf(Unpooled.buffer());
    }
}
