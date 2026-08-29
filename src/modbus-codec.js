'use strict';

// Pure Modbus TCP frame encode/decode. No I/O.
// Frame = 7-byte MBAP header (txId u16, protoId u16=0, length u16, unitId u8) + PDU.

const FN_CODES = { coil: 1, discrete: 2, holding: 3, input: 4 };
const CODE_FN = Object.fromEntries(Object.entries(FN_CODES).map(([k, v]) => [v, k]));

function encodeReadRequest({ txId, unit, fn, address, quantity }) {
  const code = FN_CODES[fn];
  if (!code) throw new Error('bad fn: ' + fn);
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(code, 0);
  pdu.writeUInt16BE(address & 0xffff, 1);
  pdu.writeUInt16BE(quantity & 0xffff, 3);
  const mbap = Buffer.alloc(7);
  mbap.writeUInt16BE(txId & 0xffff, 0);
  mbap.writeUInt16BE(0, 2); // protocol id
  mbap.writeUInt16BE(pdu.length + 1, 4); // length = unit id + pdu
  mbap.writeUInt8(unit & 0xff, 6);
  return Buffer.concat([mbap, pdu]);
}

function decodeResponse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 9) throw new Error('short modbus frame');
  const txId = buf.readUInt16BE(0);
  const len = buf.readUInt16BE(4);
  const unit = buf.readUInt8(6);
  const fnByte = buf.readUInt8(7);
  if (buf.length < 6 + len) throw new Error('truncated modbus frame');

  if (fnByte & 0x80) {
    const code = buf.readUInt8(8);
    const err = new Error('modbusException ' + code);
    err.modbusException = code;
    throw err;
  }

  const fn = CODE_FN[fnByte];
  if (!fn) throw new Error('unknown fn code ' + fnByte);

  const byteCount = buf.readUInt8(8);
  const body = buf.subarray(9, 9 + byteCount);
  if (body.length < byteCount) throw new Error('truncated modbus frame');

  let data;
  if (fn === 'coil' || fn === 'discrete') {
    data = [];
    for (let i = 0; i < byteCount * 8; i++) {
      data.push(((body[i >> 3] >> (i & 7)) & 1) === 1);
    }
  } else {
    data = [];
    for (let i = 0; i + 1 < body.length; i += 2) data.push(body.readUInt16BE(i));
  }

  return { txId, unit, fn, data };
}

module.exports = { encodeReadRequest, decodeResponse, FN_CODES };
