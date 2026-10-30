import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { downloadWebexAttachment, pruneInboundDir, safeFileName } from "./download";

function fakeFetch(contentType: string, body: string, extraHeaders: Record<string, string> = {}) {
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": contentType, "content-disposition": 'attachment; filename="page.html"', ...extraHeaders },
    })) as any;
}

describe("downloadWebexAttachment", () => {
  it("accepts an HTML file", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wx-dl-"));
    const result = await downloadWebexAttachment("https://webexapis.com/v1/contents/x", "t", {
      fetchImpl: fakeFetch("text/html; charset=utf-8", "<html></html>"),
      tmpDir,
    });
    expect(result?.contentType).toBe("text/html");
    expect(result?.localPath.endsWith(".html")).toBe(true);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reports a refused type instead of dropping it silently", async () => {
    const warnings: string[] = [];
    const result = await downloadWebexAttachment("https://webexapis.com/v1/contents/x", "t", {
      fetchImpl: fakeFetch("application/x-msdownload", "MZ"),
      onWarn: (m) => warnings.push(m),
    });
    expect(result).toBeNull();
    expect(warnings).toEqual(["rejected attachment: unsupported content-type application/x-msdownload"]);
  });

  it("reports a file over the size limit", async () => {
    const warnings: string[] = [];
    const result = await downloadWebexAttachment("https://webexapis.com/v1/contents/x", "t", {
      fetchImpl: fakeFetch("application/pdf", "x", { "content-length": String(30 * 1024 * 1024) }),
      onWarn: (m) => warnings.push(m),
    });
    expect(result).toBeNull();
    expect(warnings[0]).toMatch(/larger than 25 MB/);
  });
});

describe("inbound folder", () => {
  it("keeps the file's own name, timestamp-prefixed", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wx-in-"));
    const result = await downloadWebexAttachment("https://webexapis.com/v1/contents/x", "t", {
      fetchImpl: fakeFetch("text/html", "<html></html>"),
      tmpDir,
      keepName: true,
    });
    expect(path.dirname(result!.localPath)).toBe(tmpDir);
    expect(path.basename(result!.localPath)).toMatch(/^\d{8}-\d{6}-page\.html$/);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("makes names safe", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName(".hidden")).toBe("hidden");
    expect(safeFileName("a b/c:d?.pdf")).toBe("c_d_.pdf");
    expect(safeFileName("")).toBe("file");
  });

  it("prunes files older than the limit", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wx-prune-"));
    await fs.writeFile(path.join(dir, "old.txt"), "x");
    await fs.writeFile(path.join(dir, "new.txt"), "y");
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    await fs.utimes(path.join(dir, "old.txt"), old, old);
    await pruneInboundDir(dir, 7 * 24 * 3600 * 1000);
    expect((await fs.readdir(dir)).sort()).toEqual(["new.txt"]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
