import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { downloadWebexAttachment } from "./download";

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
