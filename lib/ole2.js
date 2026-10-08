'use strict';

/**
 * 最小实现的 OLE2 / 复合文档（Compound File Binary）读取器。
 *
 * 旧版 Excel（.xls，BIFF8）文件本身就是 OLE2 容器，内部有一个名为
 * "Workbook"（BIFF8）或 "Book"（BIFF5）的流。这里只实现读取“某个流的内容”
 * 所需的最小逻辑，不做任何写操作。
 *
 * 参考实现依据公开的 [MS-CFB] 规范。
 */

const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const MAXREGSECT = 0xfffffffa;

function isOle2(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 512 && buffer.subarray(0, 8).equals(OLE_SIGNATURE);
}

class Ole2File {
  constructor(buffer) {
    if (!isOle2(buffer)) {
      throw new Error('不是有效的 OLE2 复合文档（.xls）文件头');
    }
    this.buf = buffer;

    const sectorShift = buffer.readUInt16LE(0x1e);
    const miniSectorShift = buffer.readUInt16LE(0x20);
    if (sectorShift < 7 || sectorShift > 20) throw new Error('OLE2 扇区大小异常');
    if (miniSectorShift < 4 || miniSectorShift > sectorShift) throw new Error('OLE2 小扇区大小异常');

    this.sectorSize = 1 << sectorShift;
    this.miniSectorSize = 1 << miniSectorShift;
    this.miniCutoff = buffer.readUInt32LE(0x38);

    this.fat = this._readFatTable();
    this.dirEntries = this._readDirectoryEntries();

    const root = this.dirEntries.find((e) => e.type === 5);
    if (!root) throw new Error('OLE2 目录中缺少根条目');

    this.miniFat = this._readSectorChainAsUint32(root.miniFatStart, root.miniFatCount);
    this.miniStream = this._readChain(root.start, root.size);
  }

  /** 读取 DIFAT → FAT 扇区号列表 */
  _difatSectors() {
    const buf = this.buf;
    const list = [];
    for (let i = 0; i < 109; i += 1) {
      const v = buf.readUInt32LE(0x4c + i * 4);
      if (v > MAXREGSECT) break;
      list.push(v);
    }

    let next = buf.readUInt32LE(0x44);
    const perSector = this.sectorSize / 4 - 1;
    let guard = 0;
    while (next <= MAXREGSECT && guard < 100000) {
      guard += 1;
      const base = this._sectorOffset(next);
      if (base + this.sectorSize > buf.length) break;
      for (let i = 0; i < perSector; i += 1) {
        const v = buf.readUInt32LE(base + i * 4);
        if (v > MAXREGSECT) continue;
        list.push(v);
      }
      next = buf.readUInt32LE(base + perSector * 4);
    }
    return list;
  }

  _readFatTable() {
    const fatSectors = this._difatSectors();
    const entries = [];
    const perSector = this.sectorSize / 4;
    for (const sec of fatSectors) {
      const base = this._sectorOffset(sec);
      if (base + this.sectorSize > this.buf.length) continue;
      for (let i = 0; i < perSector; i += 1) {
        entries.push(this.buf.readUInt32LE(base + i * 4));
      }
    }
    return entries;
  }

  _sectorOffset(sector) {
    return (sector + 1) * this.sectorSize;
  }

  /** 按 FAT 链读取一串扇区并拼成 Buffer */
  _readChain(startSector, byteLength) {
    if (startSector > MAXREGSECT) return Buffer.alloc(0);
    const chunks = [];
    let sector = startSector;
    let remaining = Number.isFinite(byteLength) && byteLength >= 0 ? byteLength : Infinity;
    let guard = 0;

    while (sector <= MAXREGSECT && guard < 1e6) {
      guard += 1;
      const base = this._sectorOffset(sector);
      if (base >= this.buf.length) break;
      const end = Math.min(base + this.sectorSize, this.buf.length);
      chunks.push(this.buf.subarray(base, end));
      if (Number.isFinite(remaining)) {
        remaining -= end - base;
        if (remaining <= 0) break;
      }
      const next = this.fat[sector];
      if (next === undefined || next === ENDOFCHAIN || next === FREESECT) break;
      sector = next;
    }

    const out = Buffer.concat(chunks);
    if (Number.isFinite(byteLength) && byteLength >= 0 && out.length > byteLength) {
      return out.subarray(0, byteLength);
    }
    return out;
  }

  /** 按 MiniFAT 链读取小流（小于 miniCutoff 的流存放在根流里） */
  _readMiniChain(startSector, byteLength) {
    if (startSector > MAXREGSECT) return Buffer.alloc(0);
    const chunks = [];
    let sector = startSector;
    let remaining = Number.isFinite(byteLength) && byteLength >= 0 ? byteLength : Infinity;
    let guard = 0;

    while (sector <= MAXREGSECT && guard < 1e6) {
      guard += 1;
      const base = sector * this.miniSectorSize;
      if (base >= this.miniStream.length) break;
      const end = Math.min(base + this.miniSectorSize, this.miniStream.length);
      chunks.push(this.miniStream.subarray(base, end));
      if (Number.isFinite(remaining)) {
        remaining -= end - base;
        if (remaining <= 0) break;
      }
      const next = this.miniFat[sector];
      if (next === undefined || next === ENDOFCHAIN || next === FREESECT) break;
      sector = next;
    }

    const out = Buffer.concat(chunks);
    if (Number.isFinite(byteLength) && byteLength >= 0 && out.length > byteLength) {
      return out.subarray(0, byteLength);
    }
    return out;
  }

  _readSectorChainAsUint32(startSector, count) {
    const chunks = [];
    let sector = startSector;
    let guard = 0;
    while (sector <= MAXREGSECT && guard < count + 10) {
      guard += 1;
      const base = this._sectorOffset(sector);
      if (base + this.sectorSize > this.buf.length) break;
      for (let i = 0; i < this.sectorSize / 4; i += 1) {
        chunks.push(this.buf.readUInt32LE(base + i * 4));
      }
      const next = this.fat[sector];
      if (next === undefined || next === ENDOFCHAIN || next === FREESECT) break;
      sector = next;
    }
    return chunks;
  }

  _readDirectoryEntries() {
    const firstDir = this.buf.readUInt32LE(0x30);
    const raw = this._readChain(firstDir, -1);
    const entries = [];
    for (let off = 0; off + 128 <= raw.length; off += 128) {
      const nameLen = raw.readUInt16LE(off + 0x40);
      const type = raw.readUInt8(off + 0x42);
      let name = '';
      if (nameLen >= 2 && nameLen <= 64) {
        name = raw.subarray(off, off + nameLen - 2).toString('utf16le');
      }
      const start = raw.readUInt32LE(off + 0x74);
      const sizeLow = raw.readUInt32LE(off + 0x78);
      const sizeHigh = raw.readUInt32LE(off + 0x7c);
      const size = sizeHigh > 0 ? sizeHigh * 2 ** 32 + sizeLow : sizeLow;
      entries.push({
        name,
        type,
        start,
        size,
        // 根条目复用 start/size 字段存放 MiniFAT 的位置与数量
        miniFatStart: start,
        miniFatCount: sizeLow,
      });
    }
    return entries;
  }

  listStreams() {
    return this.dirEntries.filter((e) => e.type === 2).map((e) => e.name);
  }

  getStream(name) {
    const wanted = String(name).toLowerCase();
    const entry = this.dirEntries.find((e) => e.type === 2 && e.name.toLowerCase() === wanted);
    if (!entry) return null;
    if (entry.size < this.miniCutoff) {
      return this._readMiniChain(entry.start, entry.size);
    }
    return this._readChain(entry.start, entry.size);
  }
}

module.exports = { Ole2File, isOle2 };
