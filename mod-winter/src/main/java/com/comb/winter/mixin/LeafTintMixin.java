package com.comb.winter.mixin;

import net.minecraft.client.Minecraft;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.LeavesBlock;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * §3 — white leaves.
 *
 * Colouring the foliage instead of retexturing it keeps every resource pack
 * working: the tint index is overwritten with near-white while winter is on.
 */
@Mixin(LeavesBlock.class)
public abstract class LeafTintMixin {
    @Inject(method = "getFoliageColor", at = @At("HEAD"), cancellable = true, require = 0)
    private static void winter$whiteLeaves(CallbackInfoReturnable<Integer> info) {
        Minecraft client = Minecraft.getInstance();
        if (client.level == null) return;
        if (client.level.dimension() != Level.OVERWORLD) return;
        if (com.comb.winter.compat.WinterConfig.whiteLeaves()) info.setReturnValue(0xEDF3F8);
    }
}
