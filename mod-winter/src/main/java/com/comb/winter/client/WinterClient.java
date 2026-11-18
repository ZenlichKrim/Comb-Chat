package com.comb.winter.client;

import com.comb.winter.hud.WinterHud;
import com.comb.winter.net.WinterNet;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.rendering.v1.HudRenderCallback;

public class WinterClient implements ClientModInitializer {
    @Override
    public void onInitializeClient() {
        WinterNet.registerClient();
        // HUD draws last so the frost vignette sits above the vanilla bars, like
        // powder snow does — the spec asks for exactly that reuse.
        HudRenderCallback.EVENT.register(new WinterHud());
    }
}
