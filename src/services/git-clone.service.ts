import { execSync } from "child_process";
import { mkdtempSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Git Clone Service.
 *
 * Clones remote repositories into temporary directories.
 * Caches by URL to avoid re-cloning the same repo multiple times.
 */

const cloneCache = new Map<string, { localPath: string; clonedAt: Date }>();

/**
 * Normalize a git URL to a consistent cache key.
 * Strips trailing .git and trailing slashes.
 */
function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
}

/**
 * Extract a repo name from a git URL for the temp dir name.
 */
function extractRepoName(url: string): string {
  const parts = normalizeUrl(url).split("/");
  return parts[parts.length - 1] || "repo";
}

/**
 * Clone a git repository. Returns the local path.
 * Uses shallow clone (depth=1) for speed.
 *
 * If already cloned within the last 30 minutes, returns cached path.
 * If cached but stale, pulls latest changes instead of re-cloning.
 */
export function cloneRepository(gitUrl: string): {
  localPath: string;
  cached: boolean;
} {
  const key = normalizeUrl(gitUrl);

  // Check cache
  const cached = cloneCache.get(key);
  if (cached && Date.now() - cached.clonedAt.getTime() < 30 * 60 * 1000) {
    // Pull latest if cached
    try {
      execSync("git pull --ff-only", {
        cwd: cached.localPath,
        timeout: 15000,
        stdio: "pipe",
      });
    } catch {
      // Pull failed — stale cache is still usable
    }
    return { localPath: cached.localPath, cached: true };
  }

  // Clone fresh
  const repoName = extractRepoName(gitUrl);
  const tempDir = mkdtempSync(join(tmpdir(), `ppa-${repoName}-`));

  console.log(`[Clone] Cloning ${gitUrl} → ${tempDir}`);

  execSync(`git clone --depth 1 "${gitUrl}" "${tempDir}"`, {
    timeout: 60000,
    stdio: "pipe",
  });

  cloneCache.set(key, { localPath: tempDir, clonedAt: new Date() });
  console.log(`[Clone] Done: ${tempDir}`);

  return { localPath: tempDir, cached: false };
}

/**
 * Check if a string looks like a git URL.
 */
export function isGitUrl(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\//i.test(trimmed) ||
    /^git@/i.test(trimmed) ||
    trimmed.endsWith(".git")
  );
}
