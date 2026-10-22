import fs from "node:fs/promises";
import path from "node:path";
import type { RepoConfig } from "./types";
import { complete } from "./llm";
import { walkRepo } from "./walk";

const PLACEHOLDER = /^\s*$|^placeholder\b|\bTODO\b/i;

export function needsDescription(repo: RepoConfig): boolean {
  return PLACEHOLDER.test(repo.description ?? "");
}

async function read(file: string, max: number): Promise<string> {
  try {
    return (await fs.readFile(file, "utf8")).slice(0, max);
  } catch {
    return "";
  }
}

/** Cheap, LLM-free hints: package.json / pom.xml description, first README paragraph. */
async function gatherHints(repoPath: string): Promise<{ manifest: string; readme: string; layout: string }> {
  const parts: string[] = [];

  const pkg = await read(path.join(repoPath, "package.json"), 50_000);
  if (pkg) {
    try {
      const j = JSON.parse(pkg) as { name?: string; description?: string };
      parts.push(`package.json: name=${j.name ?? ""} description=${j.description ?? ""}`);
    } catch {
      /* ignore malformed */
    }
  }

  const pom = await read(path.join(repoPath, "pom.xml"), 30_000);
  if (pom) {
    // top-level project fields only (before <dependencies>/<build>) to avoid dependency names
    const head = pom.split(/<(?:dependencyManagement|dependencies|build|modules)>/)[0];
    const pick = (tag: string) => new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(head)?.[1]?.trim() ?? "";
    parts.push(`pom.xml: artifactId=${pick("artifactId")} name=${pick("name")} description=${pick("description")}`);
    const modules = [...pom.matchAll(/<module>([^<]+)<\/module>/g)].map((m) => m[1]);
    if (modules.length) parts.push(`maven modules: ${modules.slice(0, 20).join(", ")}`);
  }

  const gradle = (await read(path.join(repoPath, "settings.gradle"), 5_000)) || (await read(path.join(repoPath, "settings.gradle.kts"), 5_000));
  if (gradle) parts.push(`settings.gradle: ${gradle.replace(/\s+/g, " ").slice(0, 400)}`);

  let readme = "";
  for (const n of ["README.md", "readme.md", "README.rst", "README.txt", "README"]) {
    readme = await read(path.join(repoPath, n), 3_500);
    if (readme) break;
  }

  const files = await walkRepo(repoPath);
  const topDirs = [...new Set(files.map((f) => f.rel.split("/")[0]).filter((x, _i) => x))].slice(0, 40);
  const javaPkgs = [...new Set(files.filter((f) => f.rel.endsWith(".java")).map((f) => path.posix.dirname(f.rel)))]
    .slice(0, 25)
    .map((p) => p.replace(/^.*?src\/main\/java\//, ""));
  const layout = `top-level entries: ${topDirs.join(", ")}\njava packages (sample): ${javaPkgs.join(", ") || "(none)"}`;

  return { manifest: parts.join("\n"), readme, layout };
}

function fallbackFromHints(name: string, h: { manifest: string; readme: string }): string {
  const desc = /(?:description)=([^\n]+?)(?:\s+\w+=|$)/.exec(h.manifest)?.[1]?.trim();
  if (desc) return desc;
  const para = h.readme.split(/\n\s*\n/).map((p) => p.replace(/^#+\s*/gm, "").trim()).find((p) => p.length > 30);
  return para ? para.replace(/\s+/g, " ").slice(0, 200) : `Repository ${name}`;
}

/** One-sentence description for a repo, derived from its README/manifests/layout via Claude. */
export async function deriveDescription(repo: RepoConfig): Promise<string> {
  const h = await gatherHints(repo.path);
  try {
    const out = await complete(
      "You write one-sentence repository descriptions for an architecture catalogue. Output only the sentence: max 30 words, plain text, no quotes, no markdown. State what the service does and its role; do not guess beyond the evidence.",
      `Repository name: ${repo.name}\n\n# Manifest hints\n${h.manifest || "(none)"}\n\n# Layout\n${h.layout}\n\n# README excerpt\n${h.readme || "(no README)"}`,
      200,
    );
    return out.replace(/^["'\s]+|["'\s]+$/g, "").replace(/\s+/g, " ") || fallbackFromHints(repo.name, h);
  } catch {
    return fallbackFromHints(repo.name, h);
  }
}

/** Fill in missing/placeholder descriptions; returns new repo objects (config file is not modified). */
export async function resolveDescriptions(repos: RepoConfig[], onResolved?: (name: string, description: string) => void): Promise<RepoConfig[]> {
  const out: RepoConfig[] = [];
  for (const r of repos) {
    if (!needsDescription(r)) {
      out.push(r);
      continue;
    }
    const description = await deriveDescription(r);
    onResolved?.(r.name, description);
    out.push({ ...r, description });
  }
  return out;
}
