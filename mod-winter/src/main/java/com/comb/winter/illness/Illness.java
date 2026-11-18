package com.comb.winter.illness;

import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;

/**
 * §8 — five illnesses that hook into the systems instead of being debuffs with a
 * timer: a gift rash that pays you in loot, a parasite that gives you quests, a
 * winter kiss that spreads between players, snow blindness, and sleeping sickness.
 *
 * State lives on the player's persistent NBT so it survives death and relog.
 */
public final class Illness {
    private Illness() {}

    public static final String ROOT = "winter:illness";

    public static CompoundTag tag(ServerPlayer player) {
        CompoundTag root = player.getPersistentData();
        if (!root.contains(ROOT)) root.put(ROOT, new CompoundTag());
        return root.getCompound(ROOT);
    }

    public static int stage(ServerPlayer player) { return tag(player).getInt("kiss"); }

    /** §8.1 gift rash: every gift adds a stack, each stack costs 1 HP per 2s. */
    public static void addRashStack(ServerPlayer player) {
        CompoundTag t = tag(player);
        t.putInt("rash", t.getInt("rash") + 1);
    }

    public static int rash(ServerPlayer player) { return tag(player).getInt("rash"); }

    /** §8.2 parasite dependency: medicines taken, 5 = overdose. */
    public static void addDependency(ServerPlayer player) {
        CompoundTag t = tag(player);
        int stacks = t.getInt("dependency") + 1;
        t.putInt("dependency", stacks);
        if (stacks >= 5) MainIllnessEffects.overdose(player);
        else if (stacks >= 3) MainIllnessEffects.withdrawal(player, stacks);
    }

    public static int dependency(ServerPlayer player) { return tag(player).getInt("dependency"); }

    /** §8.3 the kiss advances a stage per in-game day if untreated. */
    public static void advanceKiss(ServerPlayer player) {
        CompoundTag t = tag(player);
        int next = Math.min(3, t.getInt("kiss") + 1);
        t.putInt("kiss", next);
        player.displayClientMessage(net.minecraft.network.chat.Component.translatable("winter.chat.kiss", next), false);
    }

    /** §8.4 snow blindness: pure client fog, driven by exposure time. */
    public static boolean snowBlind(ServerPlayer player) { return tag(player).getBoolean("snowblind"); }

    public static void setSnowBlind(ServerPlayer player, boolean value) {
        tag(player).putBoolean("snowblind", value);
    }

    /** §8.5 sleeping sickness: a half-second blackout every 30 seconds. */
    public static void microSleep(ServerPlayer player) {
        player.addEffect(new MobEffectInstance(MobEffects.DARKNESS, 10, 0, false, false));
        player.addEffect(new MobEffectInstance(MobEffects.MOVEMENT_SLOWDOWN, 20, 1, true, false));
    }
}

/** The heavy effects, kept separate so Illness stays readable. */
final class MainIllnessEffects {
    private MainIllnessEffects() {}

    static void overdose(ServerPlayer player) {
        player.displayClientMessage(net.minecraft.network.chat.Component.translatable("winter.chat.overdose"), true);
        player.hurt(player.damageSources().magic(), 1.0f);
    }

    static void withdrawal(ServerPlayer player, int stacks) {
        player.addEffect(new MobEffectInstance(MobEffects.CONFUSION, 200, 0, true, false));
        player.addEffect(new MobEffectInstance(MobEffects.WEAKNESS, 200, stacks - 3, true, false));
    }
}
