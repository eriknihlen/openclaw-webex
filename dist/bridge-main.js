"use strict";
/**
 * Webex event bridge process (see bridge.ts).
 *
 *   node dist/bridge-main.js            run the bridge
 *   node dist/bridge-main.js --health   exit 0 when the local bridge reports Mercury connected
 *
 * Environment:
 *   WEBEX_BOT_TOKEN_FILE     bot token file   (default /run/blueprint-secrets/WEBEX_BOT_TOKEN)
 *   WEBEX_BRIDGE_TOKEN_FILE  subscriber token (default /run/blueprint-secrets/WEBEX_BRIDGE_TOKEN)
 *   WEBEX_BRIDGE_PORT        listen port      (default 8790, all interfaces: run it on a private network)
 *   WEBEX_ACCOUNT            account id, for log lines only
 *
 * Both tokens are read from their files when used (device registration,
 * each subscribe), never from the environment or the command line, and
 * never logged.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = __importDefault(require("node:http"));
const node_fs_1 = require("node:fs");
const bridge_1 = require("./bridge");
const websocket_1 = require("./websocket");
const botTokenFile = process.env.WEBEX_BOT_TOKEN_FILE ?? "/run/blueprint-secrets/WEBEX_BOT_TOKEN";
const bridgeTokenFile = process.env.WEBEX_BRIDGE_TOKEN_FILE ?? "/run/blueprint-secrets/WEBEX_BRIDGE_TOKEN";
const port = Number(process.env.WEBEX_BRIDGE_PORT ?? 8790);
const account = process.env.WEBEX_ACCOUNT ?? "bot";
function log(level, msg) {
    const line = `${new Date().toISOString()} [webex-bridge] ${msg}`;
    if (level === "info")
        console.log(line);
    else
        console.error(line);
}
function readToken(file) {
    return (0, node_fs_1.readFileSync)(file, "utf8").trim();
}
async function health() {
    const ok = await new Promise((resolve) => {
        const req = node_http_1.default.get({ host: "127.0.0.1", port, path: bridge_1.BRIDGE_HEALTH_PATH, timeout: 3_000 }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on("timeout", () => req.destroy());
        req.on("error", () => resolve(false));
    });
    process.exit(ok ? 0 : 1);
}
async function main() {
    // The secrets agent writes the files shortly after start.
    for (let i = 0; i < 60 && !((0, node_fs_1.existsSync)(botTokenFile) && (0, node_fs_1.existsSync)(bridgeTokenFile)); i++) {
        await new Promise((r) => setTimeout(r, 2_000));
    }
    if (!readToken(botTokenFile) || !readToken(bridgeTokenFile)) {
        log("error", `token files missing or empty: ${botTokenFile}, ${bridgeTokenFile}`);
        process.exit(1);
    }
    // The transport reads config.token for each device registration; a getter
    // keeps it current with the file.
    const config = {
        get token() {
            return readToken(botTokenFile);
        },
    };
    let mercury;
    const bridge = (0, bridge_1.createBridgeServer)({
        bridgeToken: () => readToken(bridgeTokenFile),
        isUpstreamConnected: () => Boolean(mercury?.connected),
        onLog: log,
    });
    mercury = new websocket_1.WebexMercuryTransport(config, account, { onPayload: bridge.deliver, onLog: log });
    await new Promise((resolve) => bridge.server.listen(port, resolve));
    log("info", `listening on :${port}`);
    // The first registration can fail (network, Webex); retry like a reconnect.
    for (let delay = 1_000;; delay = Math.min(delay * 2, 60_000)) {
        try {
            await mercury.start();
            break;
        }
        catch (err) {
            log("warn", `mercury start failed (${err instanceof Error ? err.message : err}); retrying in ${delay / 1000}s`);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    const shutdown = async (signal) => {
        log("info", `${signal}: closing mercury and the server`);
        await mercury?.stop(); // deletes the WDM device
        await bridge.close();
        process.exit(0);
    };
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));
}
if (process.argv.includes("--health"))
    void health();
else
    main().catch((err) => {
        log("error", `fatal: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
    });
//# sourceMappingURL=bridge-main.js.map