// Prints a suggested description for every repo in repos.config.json that lacks one (does not edit the file).
// Usage: npm run describe
import dotenv from "dotenv";
import { loadRepoConfig } from "../lib/context-agent/config";
import { resolveDescriptions, needsDescription } from "../lib/context-agent/describe";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

async function main() {
  const repos = loadRepoConfig();
  const todo = repos.filter(needsDescription).length;
  console.log(`${todo} of ${repos.length} repo(s) need a description...\n`);
  const resolved = await resolveDescriptions(repos, (name, d) => console.log(`- ${name}: ${d}`));
  console.log("\nPaste into repos.config.json if you like them (otherwise indexing derives them automatically):\n");
  console.log(JSON.stringify(resolved, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
