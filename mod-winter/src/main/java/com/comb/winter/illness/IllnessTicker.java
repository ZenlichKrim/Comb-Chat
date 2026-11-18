package com.comb.winter.illness;

import com.comb.winter.core.StatsTicker;
import com.comb.winter.core.WinterStats;
import com.comb.winter.weather.WeatherState;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.item.Items;

/**
 * The clock side of §8: exposure turns into illness, untreated illness hurts, and
 * the symptoms are visible enough that the player understands what happened.
 */
public final class IllnessTicker {
    private IllnessTicker() {}

    private static int seconds = 0;

    public static void tick(MinecraftServer server) {
        if (++seconds % 20 != 0) return;
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            WinterStats stats = StatsTicker.stats(player);
            WeatherState weather = WeatherState.at(player.level(), player.blockPosition());

            // §8.3 the winter kiss: 20+ minutes of storm without shelter
            if (stats.stormExposure >= 1200 && Illness.stage(player) == 0 && player.getRandom().nextDouble() < 0.05) {
                Illness.advanceKiss(player);
            }

            // §8.4 snow blindness: 15+ minutes of blizzard exposure
            if (stats.stormExposure >= 900 && !Illness.snowBlind(player) && weather.stormIntensity > 0.6) {
                Illness.setSnowBlind(player, true);
                player.displayClientMessage(net.minecraft.network.chat.Component.translatable("winter.chat.snowblind"), true);
            }
            if (Illness.snowBlind(player) && StatsTicker.isSheltered(player)) {
                Illness.setSnowBlind(player, false);          // 3 minutes indoors cures it
            }

            // §8.1 rash damage: one HP per two seconds per stack
            int rash = Illness.rash(player);
            if (rash > 0 && seconds % 2 == 0) player.hurt(player.damageSources().magic(), rash * 0.5f);

            // §8.5 sleeping sickness: micro-sleeps
            if (Illness.tag(player).getBoolean("sleeping") && seconds % 30 == 0) Illness.microSleep(player);

            // §8 kiss stages: movement and hunger penalties
            int stage = Illness.stage(player);
            if (stage >= 2) player.addEffect(new MobEffectInstance(MobEffects.MOVEMENT_SLOWDOWN, 60, 0, true, false));
            if (stage >= 3) player.addEffect(new MobEffectInstance(MobEffects.HUNGER, 60, 0, true, false));
        }
    }

    /** §8.1: a gift every two minutes, with a stack of rash to go with it. */
    public static void giveGift(ServerPlayer player) {
        var stack = new net.minecraft.world.item.ItemStack(
                switch (player.getRandom().nextInt(4)) {
                    case 0 -> Items.BREAD;
                    case 1 -> Items.COAL;
                    case 2 -> Items.IRON_INGOT;
                    default -> Items.LEATHER;
                }, 1 + player.getRandom().nextInt(3));
        player.getInventory().placeItemBackInInventory(stack);
        Illness.addRashStack(player);
        player.displayClientMessage(net.minecraft.network.chat.Component.translatable("winter.chat.gift"), true);
    }
}
