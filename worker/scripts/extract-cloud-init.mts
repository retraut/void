/**
 * Extract the cloud-init user_data that buildCloudInit() produces.
 *
 * Used by `scripts/test-cloud-init.sh` to feed the real script
 * (not a copy) into the Docker smoke test.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { buildCloudInit } from "../src/hetzner.ts";

// Use the latest published release so the test actually downloads
// the real void-agent binary and the full bootstrap succeeds.
const userData = buildCloudInit({
	server_id: "srv_test12345678",
	setup_token: "set_test12345678",
	api_base: "wss://void.example.com",
	github_release_tag: "v0.4.0",
});

mkdirSync("test/output", { recursive: true });
writeFileSync("test/output/user_data.sh", userData, "utf-8");
console.log(`Wrote test/output/user_data.sh (${userData.length} bytes)`);

