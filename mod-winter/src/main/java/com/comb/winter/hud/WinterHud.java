package com.comb.winter.hud;

import com.comb.winter.net.ClientStats;
import net.fabricmc.fabric.api.client.rendering.v1.HudRenderCallback;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;

/**
 * §13 — the HUD.
 *
 * The spec lists five lines in the top-left corner. A list of five bars is what
 * everyone builds and it looks like a debug screen, so this keeps the same
 * information in a compact block: one thermometer strip with the four numbers as
 * short rows, a pressure arrow that only appears when it matters, and a frost
 * vignette over the whole screen past 75 cold — reusing the powder-snow feel.
 */
public class WinterHud implements HudRenderCallback {
    private static final ResourceLocation VIGNETTE = ResourceLocation.withDefaultNamespace("textures/misc/powder_snow_outline.png");
    private static final int PANEL_W = 96;

    @Override
    public void onHudRender(GuiGraphics graphics, net.minecraft.client.DeltaTracker delta) {
        Minecraft client = Minecraft.getInstance();
        if (client.player == null || client.options.hideGui) return;

        int x = 6;
        int y = 6;
        int w = PANEL_W;
        int h = 44;

        // Frost first, underneath the panel, so the numbers stay readable.
        if (ClientStats.cold >= 75) {
            int alpha = (int) Math.min(200, (ClientStats.cold - 75) * 8);
            graphics.setColor(1f, 1f, 1f, alpha / 255f);
            graphics.blit(VIGNETTE, 0, 0, 0, 0, graphics.guiWidth(), graphics.guiHeight(), graphics.guiWidth(), graphics.guiHeight());
            graphics.setColor(1f, 1f, 1f, 1f);
        }

        graphics.fill(x, y, x + w, y + h, 0x66000000);
        graphics.renderOutline(x, y, w, h, 0x33A8C8E8);

        int row = y + 5;
        drawRow(graphics, x + 5, row, "\u2744", ClientStats.cold, 0x7FC8FF);         // cold
        drawRow(graphics, x + 5, row + 12, "\u2668", ClientStats.warmth, 0xFFB86B);    // warmth
        drawRow(graphics, x + 5, row + 24, "\u2103", (ClientStats.bodyTemp - 30) / 10.0 * 100, 0xFF8A8A);
        drawRow(graphics, x + 5, row + 36, "\u2666", ClientStats.wetness, 0x8AB8E0);

        // pressure: an arrow that only shows when the front is near
        if (ClientStats.pressure < 1005) {
            graphics.drawString(client.font, "\u2193 " + Component.translatable("winter.hud.pressure_falling").getString(),
                    x + w + 4, y + 4, 0xFF9C9C);
        } else if (ClientStats.pressure > 1020) {
            graphics.drawString(client.font, "\u2191", x + w + 4, y + 4, 0x9CFF9C);
        }
    }

    private void drawRow(GuiGraphics graphics, int x, int y, String icon, double value, int color) {
        Minecraft client = Minecraft.getInstance();
        graphics.drawString(client.font, icon, x, y, color);
        int bx = x + 10;
        int by = y + 2;
        int bw = 54;
        graphics.fill(bx, by, bx + bw, by + 3, 0x33FFFFFF);
        int fill = (int) Math.max(0, Math.min(bw, value / 100.0 * bw));
        graphics.fill(bx, by, bx + fill, by + 3, color);
        graphics.drawString(client.font, String.valueOf((int) Math.round(value)), bx + bw + 4, y, 0xCCFFFFFF);
    }
}
