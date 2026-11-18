package com.comb.winter;

import com.comb.winter.core.StatsTicker;
import com.comb.winter.illness.IllnessTicker;
import com.comb.winter.machine.CoffeeMachine;
import com.comb.winter.net.WinterNet;
import com.comb.winter.registry.WinterBlocks;
import com.comb.winter.registry.WinterEvents;
import com.comb.winter.registry.WinterRegistry;
import com.comb.winter.weather.WeatherTicker;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.resources.ResourceLocation;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Entry point.
 *
 * Everything the mod adds is registered here in one place, in the order the spec
 * builds it: blocks and items first (they are referenced by everything else),
 * then the per-tick systems, then the network channels.
 */
public class WinterMod implements ModInitializer {
    public static final String MOD_ID = "winter";
    public static final Logger LOG = LoggerFactory.getLogger("Winter Atmosphere");

    public static ResourceLocation id(String path) {
        return ResourceLocation.fromNamespaceAndPath(MOD_ID, path);
    }

    /** One second of game time, used by every "per second" number in the spec. */
    public static final int TICK = 20;

    @Override
    public void onInitialize() {
        WinterRegistry.register();
        WinterBlocks.register();
        WinterNet.registerServer();
        WinterEvents.register();

        // The three loops are separate on purpose: stats are per-player and cheap,
        // weather is global and slow, illness hooks fire on their own rhythm.
        ServerTickEvents.END_SERVER_TICK.register(server -> {
            StatsTicker.tick(server);
            WeatherTicker.tick(server);
            IllnessTicker.tick(server);
            CoffeeMachine.tick(server);
        });

        LOG.info("Winter Atmosphere loaded — cold, wind, snow and illness are live");
    }
}
