package com.comb.winter.core;

import com.comb.winter.registry.WinterRegistry;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;

/**
 * How much the clothes on a player soften the cold, and how much they slow the
 * body's heat exchange (§4). Wet wool is half as good — that is the whole point
 * of the wetness stat, so it is applied here rather than at each call site.
 */
public final class Insulation {
    private Insulation() {}

    /** 0.0 (naked) .. ~0.49 (full wool set) — fraction of cold gain removed. */
    public static double reduction(Player player, boolean wet) {
        double sum = 0;
        for (ItemStack stack : player.getInventory().armor) {
            if (stack.isEmpty()) continue;
            if (stack.is(WinterRegistry.WOOL_HAT)) sum += 0.12;
            else if (stack.is(WinterRegistry.WOOL_SWEATER)) sum += 0.15;
            else if (stack.is(WinterRegistry.WOOL_PANTS)) sum += 0.10;
            else if (stack.is(WinterRegistry.VALENKI)) sum += 0.12;
        }
        if (player.getInventory().contains(new ItemStack(WinterRegistry.FROST_WARD))) sum += 0.20;
        if (wet) sum *= 0.5; // soaked wool insulates half as well
        return Math.min(0.85, sum);
    }

    /** Clothes slow the exchange between body and air (§1, body temperature). */
    public static double bodyExchange(Player player) {
        double pieces = 0;
        for (ItemStack stack : player.getInventory().armor) if (!stack.isEmpty()) pieces++;
        return 1.0 - Math.min(0.5, pieces * 0.12);
    }
}
