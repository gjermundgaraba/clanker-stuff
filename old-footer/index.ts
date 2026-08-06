import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { FooterState } from "./footer.js";
import { renderFooter } from "./footer.js";
import type { GitStatus } from "./git.js";
import { readGitStatus, sameGitStatus } from "./git.js";

export interface FooterExtensionDeps {
  runGitStatus?: (cwd: string) => Promise<GitStatus | null>;
}

const CODEX_FAST_STATUS_KEY = "codex-fast";

const normalizeStatus = (status: string): string =>
  status.replaceAll(/\s+/gu, " ").trim();

export const createFooterExtension =
  (deps: FooterExtensionDeps = {}) =>
  (pi: ExtensionAPI): void => {
    let generation = 0;
    let active = false;
    let git: GitStatus | null = null;
    let requestRender: (() => void) | undefined;
    const runGitStatus =
      deps.runGitStatus ??
      (async (cwd: string) => await readGitStatus(pi, cwd));

    const refreshGit = (ctx: ExtensionContext): void => {
      const currentGeneration = generation;
      void (async () => {
        const next = await runGitStatus(ctx.cwd);
        if (currentGeneration !== generation) {
          return;
        }
        if (!sameGitStatus(git, next)) {
          git = next;
          requestRender?.();
        }
      })();
    };

    const state = (
      ctx: ExtensionContext,
      statuses: ReadonlyMap<string, string>
    ): FooterState => {
      const context = ctx.getContextUsage();
      return {
        codexFast: statuses.has(CODEX_FAST_STATUS_KEY),
        context: {
          percent: context?.percent ?? 0,
          total: context?.contextWindow ?? 0,
          used: context?.tokens ?? 0,
        },
        cwd: ctx.cwd,
        extensionStatuses: [...statuses.entries()]
          .filter(([key]) => key !== CODEX_FAST_STATUS_KEY)
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([, status]) => normalizeStatus(status))
          .filter(Boolean),
        git,
        home: process.env.HOME ?? process.env.USERPROFILE,
        modelName: ctx.model?.id.split("/").pop() ?? "no-model",
        reasoning: ctx.model?.reasoning ?? false,
        thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel(),
      };
    };

    pi.on("session_start", (_event, ctx) => {
      generation += 1;
      if (ctx.mode !== "tui") {
        return;
      }
      active = true;
      ctx.ui.setFooter((tui, theme, footerData) => {
        requestRender = () => {
          tui.requestRender();
        };
        const unsubscribe = footerData.onBranchChange(() => {
          refreshGit(ctx);
        });
        return {
          dispose() {
            unsubscribe();
            active = false;
            requestRender = undefined;
          },
          // oxlint-disable-next-line eslint/no-empty-function -- theme is read per render
          invalidate() {},
          render: (width: number) =>
            renderFooter(
              state(ctx, footerData.getExtensionStatuses()),
              width,
              theme
            ),
        };
      });
      refreshGit(ctx);
    });
    pi.on("turn_end", (_event, ctx) => {
      if (active) {
        refreshGit(ctx);
      }
    });
    pi.on("thinking_level_select", () => {
      if (active) {
        requestRender?.();
      }
    });
    pi.on("session_shutdown", () => {
      generation += 1;
      active = false;
      git = null;
      requestRender = undefined;
    });
  };

export default createFooterExtension();
