/**
 * Custom footer for pi-sync.
 *
 * Renders two lines beneath the prompt: cwd + git branch + session name
 * on the left and the sync widget on the right, then a token/cost stats
 * line and the current model on the right. Reads everything live off the
 * shared `state` singleton, so /new and /reload swap the underlying ctx
 * without disturbing what the renderer sees.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { state, REFRESH_ICON_DURATION_MS } from "./state";

export function getSyncLabel(): string {
  if (state.standbyMode) return "⛓️  standby";
  const total = state.meshPeerHosts.size;
  const wsOnline = [...state.meshPeerHosts].filter((h) => state.wsConnectedPeers.has(h)).length;
  const showRefresh = Date.now() - state.lastRemoteChangeTime < REFRESH_ICON_DURATION_MS;

  let label: string;
  if (total === 0) label = "🔗";
  else if (wsOnline > 0) label = `🔗 ${wsOnline}`;
  else label = `🔗`;

  if (showRefresh && state.recentRemoteChanges.length > 0) label += ` 🔄`;
  return label;
}

function startRenderTimer() {
  if (state.renderTimer) return;
  state.renderTimer = setInterval(() => {
    state.tuiRef?.requestRender();
  }, 5000);
}

function stopRenderTimer() {
  if (state.renderTimer) { clearInterval(state.renderTimer); state.renderTimer = null; }
}

/** Wire up the pi-sync footer on the given session UI. Safe to call once
 *  per session_start; the render function reads live ctx via `state`. */
export function installFooter(ui: ExtensionUIContext) {
  ui.setFooter((tui, theme, footerData) => {
    state.tuiRef = tui;
    const unsub = footerData.onBranchChange(() => tui.requestRender());
    startRenderTimer();

    return {
      dispose() { unsub(); stopRenderTimer(); state.tuiRef = null; },
      invalidate() {},
      render(width: number): string[] {
        const liveCtx = state.currentCtx;
        if (!liveCtx) return ["", ""];

        // ── Line 1: cwd + branch left, sync label right ──
        let pwd = process.cwd();
        const home = process.env.HOME || process.env.USERPROFILE;
        if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
        const branch = footerData.getGitBranch();
        if (branch) pwd = `${pwd} (${branch})`;
        const sessionName = liveCtx.sessionManager.getSessionName();
        if (sessionName) pwd = `${pwd} • ${sessionName}`;

        const left1 = theme.fg("dim", pwd);
        const right1 = getSyncLabel();
        const pad1 = " ".repeat(Math.max(1, width - visibleWidth(left1) - visibleWidth(right1)));
        const line1 = truncateToWidth(left1 + pad1 + right1, width);

        // ── Line 2: token stats left, model info right ──
        let totalInput = 0, totalOutput = 0, totalCache = 0;
        let cost = 0;
        for (const entry of liveCtx.sessionManager.getBranch()) {
          if (entry.type === "message" && entry.message.role === "assistant") {
            const m = entry.message as AssistantMessage;
            totalInput += m.usage.input;
            totalOutput += m.usage.output;
            totalCache += (m.usage as any).cacheRead ?? 0;
            totalCache += (m.usage as any).cacheCreation ?? 0;
            cost += m.usage.cost.total;
          }
        }
        const fmt = (n: number) => n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
        let statsLeft = `↑${fmt(totalInput)} ↓${fmt(totalOutput)}`;
        if (totalCache > 0) statsLeft += ` R${fmt(totalCache)}`;
        statsLeft += ` $${cost.toFixed(3)}`;
        const contextUsage = liveCtx.getContextUsage?.();
        if (contextUsage?.percent != null) {
          const pct = contextUsage.percent.toFixed(1);
          const cw = contextUsage.contextWindow ? `/${fmt(contextUsage.contextWindow)}` : "";
          statsLeft += ` ${pct}%${cw}`;
        }

        const model = liveCtx.model;
        const right2 = model ? `${model.id} • ${model.mode || "auto"}` : "";
        const dimLeft = theme.fg("dim", statsLeft);
        const dimRight = theme.fg("dim", right2);
        const pad2 = " ".repeat(Math.max(1, width - visibleWidth(dimLeft) - visibleWidth(dimRight)));
        const line2 = truncateToWidth(dimLeft + pad2 + dimRight, width);

        return [line1, line2];
      },
    };
  });
}
