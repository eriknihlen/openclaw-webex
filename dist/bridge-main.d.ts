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
export {};
