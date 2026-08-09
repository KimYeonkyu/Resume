import { createPortfolioApplication } from "./application";
import { createExternalProtectedMediaStore } from "./media-store";
import { closeGracefully, createPortfolioHttpServer, listenLoopback } from "./node-server";
import {
  allProtectedItems,
  publicRuntimeAssetPaths,
  publicRuntimeMediaPaths,
  publicRuntimeMediaVersions,
} from "./portfolio";
import { BoundedRateLimiter } from "./rate-limiter";
import { loadRuntimeSettings } from "./runtime-config";
import { createPublicAssetStore } from "./static-store";

async function main(): Promise<void> {
  const settings = await loadRuntimeSettings();
  const [mediaStore, staticStore] = await Promise.all([
    createExternalProtectedMediaStore({
      items: allProtectedItems(),
      repositoryRoot: settings.repositoryRoot,
      root: settings.protectedMediaRoot,
    }),
    createPublicAssetStore({
      allowedPaths: publicRuntimeAssetPaths(),
      mediaVersions: publicRuntimeMediaVersions(),
      root: settings.publicRoot,
      versionedPaths: publicRuntimeMediaPaths(),
    }),
  ]);
  const rateLimiter = new BoundedRateLimiter({
    limit: settings.loginLimit,
    maxKeys: settings.loginMaxKeys,
    windowMs: settings.loginWindowMs,
  });
  const application = createPortfolioApplication({
    canonicalOrigin: settings.canonicalOrigin,
    mediaStore,
    rateLimiter,
    secrets: settings.secrets,
    sessionTtlSeconds: settings.sessionTtlSeconds,
    staticStore,
  });
  const server = createPortfolioHttpServer({
    application,
    canonicalOrigin: settings.canonicalOrigin,
    onError: () => console.error("Request handling failed"),
  });
  await listenLoopback(server, { host: settings.bindHost, port: settings.port });
  console.log(`Portfolio backend ready on ${settings.bindHost}:${settings.port}`);

  let shutdownStarted = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shutdownStarted) {
      server.closeAllConnections();
      return;
    }
    shutdownStarted = true;
    console.log(`Received ${signal}; closing portfolio backend`);
    try {
      await closeGracefully(server, { timeoutMs: 10_000 });
    } catch {
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Portfolio backend startup failed");
  process.exitCode = 1;
});
