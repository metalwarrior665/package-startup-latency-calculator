import { Buffer } from "node:buffer";

import yauzl from "yauzl";

export async function downloadZipTemplate(zipUrl: string) : Promise<Record<string, string>> {
  const response = await fetch(zipUrl);
  if (!response.ok) {
    throw new Error(`Failed to download ZIP: ${response.statusText}`);
  }

  const zipBuffer = await response.arrayBuffer();

  return new Promise((resolve, reject) => {
    const fileMap: Record<string, string> = {};

    yauzl.fromBuffer(Buffer.from(zipBuffer), { lazyEntries: true }, (err: Error | null, zipfile: yauzl.ZipFile) => {
      if (err) return reject(err);

      zipfile.readEntry();

      zipfile.on("entry", (entry: yauzl.Entry) => {
        // Directory entries end with "/"
        if (entry.fileName.endsWith("/")) {
          // Optionally track directories themselves
          // fileMap.set(entry.fileName, null);
          zipfile.readEntry();
          return;
        }

        zipfile.openReadStream(entry, (err, stream) => {
          if (err) return reject(err);

          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => {
            const content = Buffer.concat(chunks).toString("utf8");

            // Full path is already included, e.g.:
            // "src/routes/index.ts"
            fileMap[entry.fileName] = content;

            zipfile.readEntry();
          });
        });
      });

      zipfile.on("end", () => resolve(fileMap));
      zipfile.on("error", reject);
    });
  });
}