// CLI indexer. Usage: npm run index [-- repo-name ...]   (no names = every repo in repos.config.json)
import dotenv from "dotenv";
import { loadRepoConfig } from "../lib/context-agent/config";
import { indexAllRepos } from "../lib/context-agent/pipeline";
import { closePool } from "../lib/db";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

async function main() {
  const wanted = process.argv.slice(2);
  const all = loadRepoConfig();
  const repos = wanted.length ? all.filter((r) => wanted.includes(r.name)) : all;
  if (!repos.length) throw new Error(`No matching repos. Known: ${all.map((r) => r.name).join(", ")}`);
  const result = await indexAllRepos(() => {}, { repos });
  console.log(result.failedRepos.length ? `FAILED: ${result.failedRepos.join(", ")}` : "ALL DONE");
  await closePool();
  process.exit(result.failedRepos.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
