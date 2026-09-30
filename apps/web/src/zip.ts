/**
 * Minimal ZIP writer — STORE method (no compression), which needs no dependency
 * and is plenty for a bundle of text/SVG/HTML files. Produces a Blob you can
 * download. Not a general-purpose zip library; just enough for the kit export.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Entry {
  name: string;
  data: Uint8Array;
  crc: number;
  offset: number;
}

export function makeZip(files: { name: string; content: string }[]): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const entries: Entry[] = [];
  let offset = 0;

  const push = (b: Uint8Array) => {
    chunks.push(b);
    offset += b.length;
  };
  const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
  const u32 = (n: number) =>
    new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = enc.encode(f.content);
    const crc = crc32(data);
    const localOffset = offset;
    // Local file header
    push(u32(0x04034b50));
    push(u16(20)); // version
    push(u16(0)); // flags
    push(u16(0)); // method = store
    push(u16(0)); // mod time
    push(u16(0)); // mod date
    push(u32(crc));
    push(u32(data.length)); // compressed size
    push(u32(data.length)); // uncompressed size
    push(u16(nameBytes.length));
    push(u16(0)); // extra len
    push(nameBytes);
    push(data);
    entries.push({ name: f.name, data, crc, offset: localOffset });
  }

  const centralStart = offset;
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    push(u32(0x02014b50));
    push(u16(20)); // version made by
    push(u16(20)); // version needed
    push(u16(0)); // flags
    push(u16(0)); // method
    push(u16(0)); // time
    push(u16(0)); // date
    push(u32(e.crc));
    push(u32(e.data.length));
    push(u32(e.data.length));
    push(u16(nameBytes.length));
    push(u16(0)); // extra
    push(u16(0)); // comment
    push(u16(0)); // disk number
    push(u16(0)); // internal attrs
    push(u32(0)); // external attrs
    push(u32(e.offset));
    push(nameBytes);
  }
  const centralSize = offset - centralStart;

  // End of central directory
  push(u32(0x06054b50));
  push(u16(0));
  push(u16(0));
  push(u16(entries.length));
  push(u16(entries.length));
  push(u32(centralSize));
  push(u32(centralStart));
  push(u16(0));

  return new Blob(chunks as BlobPart[], { type: "application/zip" });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
