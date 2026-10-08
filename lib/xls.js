'use strict';

/**
 * 旧版 Excel（.xls / BIFF8）最小读取器。
 *
 * 只读取“工作表单元格内容”，不做任何写入；不依赖任何第三方库。
 * 支持 SST(含 CONTINUE)、LABELSST、LABEL、RSTRING、RK、MULRK、NUMBER、
 * BOOLERR、FORMULA(+STRING) 等常见记录，足以读取花名册这类表。
 *
 * 依据公开的 [MS-XLS] 规范。
 */

const { Ole2File, isOle2 } = require('./ole2');

const REC = {
  BOF: 0x0809,
  EOF: 0x000a,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  CONTINUE: 0x003c,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  RSTRING: 0x00d6,
  RK: 0x027e,
  MULRK: 0x00bd,
  NUMBER: 0x0203,
  BOOLERR: 0x0205,
  FORMULA: 0x0006,
  STRING: 0x0207,
  BLANK: 0x0201,
  MULBLANK: 0x00be,
};

function isXls(buffer) {
  return isOle2(buffer);
}

function splitRecords(stream) {
  const records = [];
  let off = 0;
  while (off + 4 <= stream.length) {
    const id = stream.readUInt16LE(off);
    const len = stream.readUInt16LE(off + 2);
    const dataStart = off + 4;
    if (dataStart + len > stream.length) {
      records.push({ id, len: stream.length - dataStart, offset: off, data: stream.subarray(dataStart) });
      break;
    }
    records.push({ id, len, offset: off, data: stream.subarray(dataStart, dataStart + len) });
    off = dataStart + len;
  }
  return records;
}

/** 跨记录（CONTINUE）的字节读取器；字符数据跨界时读取 1 字节编码标志 */
class ContinuationReader {
  constructor(segments, segIndex, offset) {
    this.segments = segments;
    this.seg = segIndex;
    this.off = offset;
    this.pendingGrbit = null;
  }

  get done() {
    return this.seg >= this.segments.length;
  }

  _advanceSegment() {
    this.seg += 1;
    this.off = 0;
    if (this.seg < this.segments.length) {
      // CONTINUE 记录开头 1 字节：字符是否 16 位
      this.pendingGrbit = this.segments[this.seg].readUInt8(0);
      this.off = 1;
    }
  }

  ensure() {
    while (!this.done && this.off >= this.segments[this.seg].length) {
      this._advanceSegment();
    }
    return !this.done;
  }

  /** 读取结构字段（不加编码标志），可跨记录 */
  u8() {
    if (!this.ensure()) return 0;
    return this.segments[this.seg].readUInt8(this.off++);
  }

  u16() {
    const a = this.u8();
    const b = this.u8();
    return a | (b << 8);
  }

  u32() {
    const a = this.u16();
    const b = this.u16();
    return (a | (b << 16)) >>> 0;
  }

  bytes(n) {
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i += 1) out[i] = this.u8();
    return out;
  }

  /** 读取一个 XLUnicodeRichExtendedString */
  richString() {
    const cch = this.u16();
    let grbit = this.u8();
    let cRun = 0;
    let cbExtRst = 0;
    if (grbit & 0x08) cRun = this.u16();
    if (grbit & 0x04) cbExtRst = this.u32();

    let out = '';
    let remaining = cch;
    while (remaining > 0) {
      if (!this.ensure()) break;
      const wide = (this.pendingGrbit !== null ? this.pendingGrbit : grbit) & 0x01;
      this.pendingGrbit = null;
      const seg = this.segments[this.seg];
      const avail = seg.length - this.off;
      if (avail <= 0) continue;
      if (wide) {
        const take = Math.min(remaining, Math.floor(avail / 2));
        out += seg.subarray(this.off, this.off + take * 2).toString('utf16le');
        this.off += take * 2;
        remaining -= take;
      } else {
        const take = Math.min(remaining, avail);
        out += latin1ToUnicode(seg.subarray(this.off, this.off + take));
        this.off += take;
        remaining -= take;
      }
      if (remaining > 0) this._advanceSegment();
    }

    // 跳过富文本运行与扩展数据（可能跨记录，且不带编码标志）
    for (let i = 0; i < cRun * 4 + cbExtRst; i += 1) {
      if (!this.ensure()) break;
      this.off += 1;
    }
    return out;
  }

  /** 读取短字符串（1 字节长度） */
  shortString() {
    const cch = this.u8();
    const grbit = this.u8();
    if (grbit & 0x01) {
      return this.bytes(cch * 2).toString('utf16le');
    }
    return latin1ToUnicode(this.bytes(cch));
  }
}

/** BIFF8 的 8 位字符按低位字节码位解释（压缩 Unicode） */
function latin1ToUnicode(buf) {
  let out = '';
  for (let i = 0; i < buf.length; i += 1) out += String.fromCharCode(buf[i]);
  return out;
}

function decodeRK(rk) {
  let value;
  if (rk & 0x02) {
    value = rk >> 2; // 30 位有符号整数
  } else {
    const tmp = Buffer.alloc(8);
    tmp.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    value = tmp.readDoubleLE(0);
  }
  if (rk & 0x01) value /= 100;
  return value;
}

function parseSst(records, index) {
  // 把 SST 与其后连续的 CONTINUE 记录合并为一个分段序列
  const segments = [records[index].data];
  let i = index + 1;
  while (i < records.length && records[i].id === REC.CONTINUE) {
    segments.push(records[i].data);
    i += 1;
  }

  const reader = new ContinuationReader(segments, 0, 8); // 跳过 cstTotal / cstUnique
  const total = segments[0].readUInt32LE(4);
  const unique = segments[0].readUInt32LE(0);
  const strings = [];
  const limit = Math.min(unique >>> 0, 2000000);
  for (let s = 0; s < limit; s += 1) {
    if (reader.done) break;
    strings.push(reader.richString());
  }
  return { strings, total, nextIndex: i };
}

/**
 * 读取 .xls 中的工作表。
 * @returns {{sheets: Array<{name:string, hidden:boolean, rows:Array<Array<any>>}>}}
 */
function readXls(buffer) {
  const ole = new Ole2File(buffer);
  const stream = ole.getStream('Workbook') || ole.getStream('Book');
  if (!stream) {
    const streams = ole.listStreams().join(', ') || '（无）';
    throw new Error(`未在工作簿中找到 Workbook 流（现有流：${streams}）`);
  }

  const records = splitRecords(stream);

  // 收集工作表目录（BOUNDSHEET）
  const sheetMeta = [];
  for (const rec of records) {
    if (rec.id === REC.BOUNDSHEET && rec.data.length >= 8) {
      const lbPlyPos = rec.data.readUInt32LE(0);
      const grbit = rec.data.readUInt8(4);
      const nameLen = rec.data.readUInt8(6);
      const flags = rec.data.readUInt8(7);
      let name = '';
      if (flags & 0x01) {
        name = rec.data.subarray(8, 8 + nameLen * 2).toString('utf16le');
      } else {
        name = latin1ToUnicode(rec.data.subarray(8, 8 + nameLen));
      }
      sheetMeta.push({
        name,
        hidden: (grbit & 0x03) !== 0,
        bofOffset: lbPlyPos,
        cells: new Map(),
      });
    }
  }

  const sst = (() => {
    const idx = records.findIndex((r) => r.id === REC.SST);
    return idx === -1 ? { strings: [] } : parseSst(records, idx);
  })();
  const sharedStrings = sst.strings;

  const byOffset = new Map(sheetMeta.map((s) => [s.bofOffset, s]));
  let current = null;
  let pendingFormulaString = null;

  const put = (sheet, row, col, value) => {
    if (row < 0 || col < 0 || row > 1048575 || col > 16383) return;
    let rowMap = sheet.cells.get(row);
    if (!rowMap) {
      rowMap = new Map();
      sheet.cells.set(row, rowMap);
    }
    rowMap.set(col, value);
  };

  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    if (rec.id === REC.BOF) {
      // 只有位于某个工作表 BOUNDSHEET 记录的偏移处，才算进入该工作表
      current = byOffset.get(rec.offset) || null;
      continue;
    }
    if (!current) continue;

    switch (rec.id) {
      case REC.LABELSST: {
        if (rec.data.length < 10) break;
        const row = rec.data.readUInt16LE(0);
        const col = rec.data.readUInt16LE(2);
        const isst = rec.data.readUInt32LE(6);
        put(current, row, col, sharedStrings[isst] !== undefined ? sharedStrings[isst] : '');
        break;
      }
      case REC.LABEL:
      case REC.RSTRING: {
        if (rec.data.length < 8) break;
        const row = rec.data.readUInt16LE(0);
        const col = rec.data.readUInt16LE(2);
        const reader = new ContinuationReader([rec.data], 0, 6);
        put(current, row, col, reader.richString());
        break;
      }
      case REC.RK: {
        if (rec.data.length < 10) break;
        const row = rec.data.readUInt16LE(0);
        const col = rec.data.readUInt16LE(2);
        put(current, row, col, decodeRK(rec.data.readInt32LE(6)));
        break;
      }
      case REC.MULRK: {
        if (rec.data.length < 12) break;
        const row = rec.data.readUInt16LE(0);
        const colFirst = rec.data.readUInt16LE(2);
        const count = Math.floor((rec.data.length - 6) / 6);
        for (let k = 0; k < count; k += 1) {
          const rk = rec.data.readInt32LE(4 + k * 6 + 2);
          put(current, row, colFirst + k, decodeRK(rk));
        }
        break;
      }
      case REC.NUMBER: {
        if (rec.data.length < 14) break;
        const row = rec.data.readUInt16LE(0);
        const col = rec.data.readUInt16LE(2);
        put(current, row, col, rec.data.readDoubleLE(6));
        break;
      }
      case REC.BOOLERR: {
        if (rec.data.length < 8) break;
        const row = rec.data.readUInt16LE(0);
        const col = rec.data.readUInt16LE(2);
        const v = rec.data.readUInt8(6);
        const isErr = rec.data.readUInt8(7);
        put(current, row, col, isErr ? '#ERR' : v !== 0);
        break;
      }
      case REC.FORMULA: {
        if (rec.data.length < 14) break;
        const row = rec.data.readUInt16LE(0);
        const col = rec.data.readUInt16LE(2);
        const b6 = rec.data.readUInt8(6);
        const b7 = rec.data.readUInt8(7);
        if (b6 === 0xff && b7 === 0xff) {
          const type = rec.data.readUInt8(8);
          if (type === 0) {
            pendingFormulaString = { row, col };
          } else if (type === 1) {
            put(current, row, col, rec.data.readUInt8(9) !== 0);
          } else if (type === 2) {
            put(current, row, col, '#ERR');
          } else {
            put(current, row, col, '');
          }
        } else {
          put(current, row, col, rec.data.readDoubleLE(6));
        }
        break;
      }
      case REC.STRING: {
        if (!pendingFormulaString) break;
        const segments = [rec.data];
        let j = i + 1;
        while (j < records.length && records[j].id === REC.CONTINUE) {
          segments.push(records[j].data);
          j += 1;
        }
        const reader = new ContinuationReader(segments, 0, 0);
        put(current, pendingFormulaString.row, pendingFormulaString.col, reader.richString());
        pendingFormulaString = null;
        break;
      }
      default:
        break;
    }
  }

  const sheets = sheetMeta.map((sheet) => {
    const rows = [];
    const rowKeys = [...sheet.cells.keys()].sort((a, b) => a - b);
    if (rowKeys.length === 0) return { name: sheet.name, hidden: sheet.hidden, rows: [] };
    const maxRow = rowKeys[rowKeys.length - 1];
    let maxCol = 0;
    for (const rowMap of sheet.cells.values()) {
      for (const c of rowMap.keys()) if (c > maxCol) maxCol = c;
    }
    for (let r = 0; r <= maxRow; r += 1) {
      const rowMap = sheet.cells.get(r);
      const row = new Array(maxCol + 1).fill('');
      if (rowMap) {
        for (const [c, v] of rowMap.entries()) row[c] = normalizeCell(v);
      }
      rows.push(row);
    }
    return { name: sheet.name, hidden: sheet.hidden, rows };
  });

  return { sheets };
}

function normalizeCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

module.exports = { isXls, readXls };
