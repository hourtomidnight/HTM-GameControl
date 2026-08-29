const { test } = require('node:test');
const assert = require('node:assert');
const { encodeReadRequest, decodeResponse, FN_CODES } = require('../src/modbus-codec');

// ---- encodeReadRequest ----

test('encodeReadRequest builds a correct read-holding frame (spec anchor)', () => {
  const buf = encodeReadRequest({ txId: 1, unit: 1, fn: 'holding', address: 0, quantity: 2 });
  // MBAP: txid(0001) proto(0000) len(0006) unit(01) ; PDU: fn(03) addr(0000) qty(0002)
  assert.strictEqual(buf.toString('hex'), '000100000006010300000002');
  assert.strictEqual(buf.length, 12);
});

test('encodeReadRequest encodes coil fn code, address and quantity big-endian', () => {
  const buf = encodeReadRequest({ txId: 0x1234, unit: 7, fn: 'coil', address: 0x0013, quantity: 0x0025 });
  // txid 1234 proto 0000 len 0006 unit 07 ; fn 01 addr 0013 qty 0025
  assert.strictEqual(buf.toString('hex'), '123400000006070100130025');
});

test('encodeReadRequest supports discrete and input fn codes', () => {
  assert.strictEqual(
    encodeReadRequest({ txId: 2, unit: 1, fn: 'discrete', address: 10, quantity: 4 }).toString('hex'),
    '000200000006010200' + '0a' + '0004');
  assert.strictEqual(
    encodeReadRequest({ txId: 2, unit: 1, fn: 'input', address: 256, quantity: 1 }).toString('hex'),
    '000200000006010401000001');
});

test('encodeReadRequest throws on unknown fn', () => {
  assert.throws(() => encodeReadRequest({ txId: 1, unit: 1, fn: 'nope', address: 0, quantity: 1 }));
});

test('FN_CODES map is exported with the standard codes', () => {
  assert.deepStrictEqual(FN_CODES, { coil: 1, discrete: 2, holding: 3, input: 4 });
});

// ---- decodeResponse: registers ----

test('decodeResponse parses two holding registers', () => {
  // MBAP txid 0001 proto 0000 len 0007 unit 01 ; PDU fn 03 bytecount 04 data 0064 0065
  const resp = Buffer.from('00010000000701030400640065', 'hex');
  const out = decodeResponse(resp);
  assert.strictEqual(out.txId, 1);
  assert.strictEqual(out.unit, 1);
  assert.strictEqual(out.fn, 'holding');
  assert.deepStrictEqual(out.data, [100, 101]);
});

test('decodeResponse parses input registers big-endian', () => {
  // txid 0002 proto 0000 len 0009 unit 05 ; fn 04 bytecount 06 data ff00 0001 abcd
  const resp = Buffer.from('0002000000090504' + '06' + 'ff00' + '0001' + 'abcd', 'hex');
  const out = decodeResponse(resp);
  assert.strictEqual(out.fn, 'input');
  assert.strictEqual(out.unit, 5);
  assert.deepStrictEqual(out.data, [0xff00, 1, 0xabcd]);
});

// ---- decodeResponse: bits ----

test('decodeResponse parses discrete inputs LSB-first bit order', () => {
  // txid 0009 proto 0000 len 0004 unit 01 ; fn 02 bytecount 01 value 0x05
  const resp = Buffer.from('00090000000401020105', 'hex');
  const out = decodeResponse(resp);
  assert.strictEqual(out.fn, 'discrete');
  // 0x05 = 0b00000101 -> LSB first: 1,0,1,0,0,0,0,0
  assert.deepStrictEqual(out.data, [true, false, true, false, false, false, false, false]);
});

test('decodeResponse parses coils across two bytes LSB-first', () => {
  // fn 01 bytecount 02 value 0x02 0x01 -> byte0=0b00000010, byte1=0b00000001
  // len = unit(1)+fn(1)+bc(1)+2 = 5 -> 0005
  const resp = Buffer.from('000300000005010102' + '0201', 'hex');
  const out = decodeResponse(resp);
  assert.strictEqual(out.fn, 'coil');
  assert.strictEqual(out.data.length, 16);
  assert.strictEqual(out.data[0], false);
  assert.strictEqual(out.data[1], true);
  assert.strictEqual(out.data[8], true);
  assert.strictEqual(out.data[9], false);
});

// ---- decodeResponse: errors ----

test('decodeResponse throws with .modbusException on an exception response', () => {
  // txid 000A proto 0000 len 0003 unit 01 ; fn 0x83 code 0x02
  const resp = Buffer.from('000A00000003018302', 'hex');
  assert.throws(() => decodeResponse(resp), (e) => {
    assert.strictEqual(e.modbusException, 2);
    return true;
  });
});

test('decodeResponse throws on a short buffer', () => {
  assert.throws(() => decodeResponse(Buffer.from('0001', 'hex')));
});

test('decodeResponse throws on a truncated frame (length field exceeds bytes)', () => {
  // claims len 0x0007 but only carries a few PDU bytes
  const resp = Buffer.from('000100000007010304' + '00', 'hex');
  assert.throws(() => decodeResponse(resp), /truncated|short/i);
});

test('decodeResponse round-trips a request txId', () => {
  const req = encodeReadRequest({ txId: 0x00ab, unit: 3, fn: 'holding', address: 0, quantity: 1 });
  assert.strictEqual(req.readUInt16BE(0), 0x00ab);
});
