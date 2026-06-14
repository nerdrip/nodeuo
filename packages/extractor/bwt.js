// Burrows-Wheeler Transform inverse, ported from
// templates/ClassicUO/src/ClassicUO.Utility/BwtDecompress.cs (1:1).
//
// Used for gumpart entries with compressionFlag === 3 (zlib + BWT) and
// for Cliloc.enu. The input is the zlib-decompressed stream; the
// output is the actual sprite/cliloc payload.

/**
 * @param {Uint8Array} buffer
 * @returns {Buffer}
 */
export function bwtDecompress(buffer) {
  // Stage 1 — outer (move-to-front) pass.
  // Skip the 4-byte header.
  let pos = 4;
  let firstChar = buffer[pos++];
  const table = new Uint16Array(256 * 256);
  buildTable(table, firstChar);

  const list = new Uint8Array(buffer.length - 4);
  let listLen = 0;

  while (pos < buffer.length) {
    let currentValue = firstChar;
    const value = table[currentValue];
    if (currentValue > 0) {
      do {
        table[currentValue] = table[currentValue - 1];
      } while (--currentValue > 0);
    }
    table[0] = value;
    list[listLen++] = value & 0xff;
    firstChar = buffer[pos++];
  }

  return internalDecompress(list, listLen);
}

function buildTable(table, startValue) {
  let firstByte = startValue;
  let secondByte = 0;
  let index = 0;
  for (let i = 0; i < 256 * 256; i++) {
    table[index++] = (firstByte | (secondByte << 8)) & 0xffff;
    firstByte = (firstByte + 1) & 0xff;
    if (firstByte === 0) secondByte = (secondByte + 1) & 0xff;
  }
  // Sort ascending.
  table.sort();
}

function internalDecompress(input, _inputLen) {
  // input layout (after the outer pass):
  //   bytes 0..1023        = 256 × i32 LE (counts per symbol, "partialInput[0..256]")
  //   bytes 1024..end      = encoded body
  const symbolTable = new Uint8Array(256);
  for (let i = 0; i < 256; i++) symbolTable[i] = i;

  // partialInput holds 256 × 3 i32 slots. The first 256 are read from the
  // input header (counts), the next 256 are positions, and the next 256
  // are end-positions.
  const partialInput = new Int32Array(256 * 3);
  // Read the first 1024 bytes as 256 × i32 (LE).
  for (let i = 0; i < 256; i++) {
    partialInput[i] =
        (input[i * 4 + 0]      )
      | (input[i * 4 + 1] << 8 )
      | (input[i * 4 + 2] << 16)
      | (input[i * 4 + 3] << 24);
  }

  let sum = 0;
  for (let i = 0; i < 256; i++) sum += partialInput[i];

  const len = sum;
  if (len <= 0) return Buffer.alloc(0);

  const output = Buffer.alloc(len);

  let nonZeroCount = 0;
  for (let i = 0; i < 256; i++) {
    if (partialInput[i] !== 0) nonZeroCount++;
  }

  // Frequency: pick the largest count first, second largest second, etc.,
  // and write the matching symbol into `frequency[i]`.
  const frequency = new Uint8Array(256);
  {
    const tmp = new Int32Array(256);
    tmp.set(partialInput.subarray(0, 256));
    for (let i = 0; i < 256; i++) {
      let value = 0, index = 0;
      for (let j = 0; j < 256; j++) {
        if (tmp[j] > value) { index = j; value = tmp[j]; }
      }
      if (value === 0) break;
      frequency[i] = index;
      tmp[index] = 0;
    }
  }

  // Build the row-start / row-end indices for each symbol.
  for (let i = 0, m = 0; i < nonZeroCount; i++) {
    const freq = frequency[i];
    // input[m + 1024] gives the symbol that, after sorting, ended up here.
    symbolTable[input[m + 1024]] = freq;
    partialInput[freq + 256] = m + 1;
    m += partialInput[freq];
    partialInput[freq + 512] = m;
  }

  let val = symbolTable[0];
  let count = 0;
  let nz = nonZeroCount;
  while (count < len) {
    const firstValIdx = val + 256;
    let firstValRef = partialInput[firstValIdx];
    output[count] = val;

    if (firstValRef >= partialInput[val + 512]) {
      if (nz-- > 0) {
        shiftLeft(symbolTable, nz);
        val = symbolTable[0];
      }
    } else {
      const idx = input[firstValRef + 1024];
      partialInput[firstValIdx] = firstValRef + 1;
      if (idx !== 0) {
        shiftLeft(symbolTable, idx);
        symbolTable[idx] = val;
        val = symbolTable[0];
      }
    }
    count++;
  }
  return output;
}

function shiftLeft(arr, max) {
  for (let i = 0; i < max; i++) arr[i] = arr[i + 1];
}
