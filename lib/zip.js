'use strict';
// Minimal streaming ZIP writer (STORE method: audio is already compressed). No Zip64.
const zlib = require('zlib');
const fs = require('fs');

function dos(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

async function streamZip(res, files) {
  const write = (b) => new Promise((ok) => (res.write(b) ? ok() : res.once('drain', ok)));
  const { time, date } = dos(new Date());
  const central = []; let offset = 0;
  for (const f of files) {
    let data;
    try { data = f.data || (await fs.promises.readFile(f.path)); } catch { continue; }
    const name = Buffer.from(f.name, 'utf8');
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    await write(lh); await write(name); await write(data);
    central.push({ name, crc, size: data.length, offset });
    offset += 30 + name.length + data.length;
  }
  let cdSize = 0;
  for (const c of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(c.crc, 16); ch.writeUInt32LE(c.size, 20); ch.writeUInt32LE(c.size, 24);
    ch.writeUInt16LE(c.name.length, 28); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(c.offset, 42);
    await write(ch); await write(c.name);
    cdSize += 46 + c.name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  res.end(end);
}
module.exports = { streamZip };
