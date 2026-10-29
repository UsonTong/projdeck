import { loadConfig } from "./config.ts";
import { HerdrClient } from "./herdr/client.ts";
import { SUPPORTED_PROTOCOL } from "./herdr/types.ts";
import { ProjectStore } from "./projects/store.ts";
import { buildServer } from "./server.ts";
import { ProjdeckService } from "./service.ts";
import { startAutoTrust } from "./trust.ts";
import { pruneUploads } from "./uploads.ts";

const config = loadConfig();
const herdr = new HerdrClient(config.herdrSocket);
const store = new ProjectStore();
const service = new ProjdeckService(config, herdr, store);
const app = await buildServer(config, service, herdr);

if (!config.passwordHash) {
  app.log.warn("尚未设置登录密码，所有登录都会被拒绝。请运行：pnpm --filter @projdeck/agentd cli set-password");
}

// herdr 未运行时不阻止启动，事件订阅会自动重连
herdr
  .ping()
  .then(({ version, protocol }) => {
    if (protocol !== SUPPORTED_PROTOCOL) {
      app.log.warn(`herdr ${version} 的协议版本为 ${protocol}，projdeck 按 ${SUPPORTED_PROTOCOL} 开发，部分功能可能异常`);
    } else {
      app.log.info(`已连接 herdr ${version}（${config.herdrSocket}）`);
    }
  })
  .catch((err: Error) => app.log.warn(`暂时无法连接 herdr：${err.message}`));
herdr.subscribe();
const stopAutoTrust = startAutoTrust(herdr, () => store.settings.autoTrust, (paneId) =>
  app.log.info(`已自动信任 ${paneId} 的工作目录`),
);

const prune = () =>
  pruneUploads(store.projects.map((p) => p.path), config.uploadRetentionDays)
    .then((n) => n && app.log.info(`已清理 ${n} 个过期上传文件`))
    .catch((err: Error) => app.log.warn(`清理上传文件失败：${err.message}`));
void prune();
setInterval(prune, 86_400_000).unref();

await app.listen({ host: config.host, port: config.port });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopAutoTrust();
    herdr.close();
    void app.close().then(() => process.exit(0));
  });
}
