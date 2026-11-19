'use strict';
/*
 * Минимальный генератор QR-кодов: байтовый режим, уровень коррекции M, версии 1–40.
 * Алгоритм по описанию ISO/IEC 18004 и реализации Project Nayuki (MIT).
 * Нужен только для показа секрета 2FA — без сторонних библиотек и без отправки секрета куда-либо.
 */
(() => {
  // Уровень M: число ECC-кодовых слов на блок и число блоков по версиям (индекс = версия).
  const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
  const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
  const ECC_FORMAT_BITS_M = 0;

  const getBit = (x, i) => ((x >>> i) & 1) !== 0;

  function numRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  const numDataCodewords = (ver) => Math.floor(numRawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];

  // ---- Рида–Соломона над GF(2^8), полином 0x11D ----
  function rsMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < result.length; j++) {
        result[j] = rsMul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = rsMul(root, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((coef, i) => {
        result[i] ^= rsMul(coef, factor);
      });
    }
    return result;
  }

  function encode(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    let ver = 1;
    let capBits = 0;
    for (; ver <= 40; ver++) {
      capBits = numDataCodewords(ver) * 8;
      if (4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 <= capBits) break;
    }
    if (ver > 40) throw new Error('Слишком длинные данные для QR-кода');

    // ---- Битовый поток данных ----
    const bits = [];
    const put = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };
    put(0x4, 4); // байтовый режим
    put(bytes.length, ver <= 9 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    put(0, Math.min(4, capBits - bits.length));
    put(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) put(pad, 8);
    const data = new Array(bits.length / 8).fill(0);
    bits.forEach((b, i) => {
      data[i >>> 3] |= b << (7 - (i & 7));
    });

    // ---- Блоки, коррекция ошибок, перемежение ----
    const numBlocks = NUM_BLOCKS[ver];
    const eccLen = ECC_PER_BLOCK[ver];
    const raw = Math.floor(numRawDataModules(ver) / 8);
    const numShort = numBlocks - (raw % numBlocks);
    const shortLen = Math.floor(raw / numBlocks);
    const div = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, div);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const codewords = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => {
        if (i !== shortLen - eccLen || j >= numShort) codewords.push(block[i]);
      });
    }

    // ---- Матрица ----
    const size = ver * 4 + 17;
    const mod = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const setF = (x, y, dark) => {
      mod[y][x] = dark;
      fn[y][x] = true;
    };

    for (let i = 0; i < size; i++) {
      setF(6, i, i % 2 === 0);
      setF(i, 6, i % 2 === 0);
    }
    const finder = (x, y) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && xx < size && yy >= 0 && yy < size) setF(xx, yy, d !== 2 && d !== 4);
        }
      }
    };
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);

    const align = [];
    if (ver > 1) {
      const n = Math.floor(ver / 7) + 2;
      const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
      align.push(6);
      for (let pos = size - 7; align.length < n; pos -= step) align.splice(1, 0, pos);
    }
    for (let i = 0; i < align.length; i++) {
      for (let j = 0; j < align.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }

    const drawFormat = (mask) => {
      const d = (ECC_FORMAT_BITS_M << 3) | mask;
      let rem = d;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const b = ((d << 10) | rem) ^ 0x5412;
      for (let i = 0; i <= 5; i++) setF(8, i, getBit(b, i));
      setF(8, 7, getBit(b, 6));
      setF(8, 8, getBit(b, 7));
      setF(7, 8, getBit(b, 8));
      for (let i = 9; i < 15; i++) setF(14 - i, 8, getBit(b, i));
      for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, getBit(b, i));
      for (let i = 8; i < 15; i++) setF(8, size - 15 + i, getBit(b, i));
      setF(8, size - 8, true);
    };
    drawFormat(0); // резервируем область формата

    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const b = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = getBit(b, i);
        const a = size - 11 + (i % 3);
        const c = Math.floor(i / 3);
        setF(a, c, bit);
        setF(c, a, bit);
      }
    }

    // Размещение кодовых слов зигзагом
    let bi = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!fn[y][x] && bi < codewords.length * 8) {
            mod[y][x] = getBit(codewords[bi >>> 3], 7 - (bi & 7));
            bi++;
          }
        }
      }
    }

    const maskFns = [
      (x, y) => (x + y) % 2 === 0,
      (x, y) => y % 2 === 0,
      (x) => x % 3 === 0,
      (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
      (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
      (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ];
    const applyMask = (m) => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && maskFns[m](x, y)) mod[y][x] = !mod[y][x];
    };

    // Упрощённая оценка маски (правила 1, 2, 4 стандарта) — подойдёт любая маска, это лишь улучшает читаемость.
    const penalty = () => {
      let p = 0;
      for (let pass = 0; pass < 2; pass++) {
        for (let a = 0; a < size; a++) {
          let run = 1;
          for (let b = 1; b < size; b++) {
            const cur = pass ? mod[b][a] : mod[a][b];
            const prev = pass ? mod[b - 1][a] : mod[a][b - 1];
            if (cur === prev) {
              run++;
              if (run === 5) p += 3;
              else if (run > 5) p++;
            } else run = 1;
          }
        }
      }
      let dark = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (mod[y][x]) dark++;
          if (x < size - 1 && y < size - 1 && mod[y][x] === mod[y][x + 1] && mod[y][x] === mod[y + 1][x] && mod[y][x] === mod[y + 1][x + 1]) p += 3;
        }
      }
      const total = size * size;
      p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
      return p;
    };

    let best = 0;
    let bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m);
      drawFormat(m);
      const s = penalty();
      if (s < bestScore) {
        bestScore = s;
        best = m;
      }
      applyMask(m); // XOR — повторное применение отменяет маску
    }
    applyMask(best);
    drawFormat(best);
    return { size, version: ver, modules: mod };
  }

  /** SVG-элемент (строится через DOM, без innerHTML — совместимо с Trusted Types). */
  function svg(text, { px = 220 } = {}) {
    const qr = encode(text);
    const quiet = 4;
    const n = qr.size + quiet * 2;
    const NS = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(NS, 'svg');
    el.setAttribute('viewBox', `0 0 ${n} ${n}`);
    el.setAttribute('width', String(px));
    el.setAttribute('height', String(px));
    el.setAttribute('shape-rendering', 'crispEdges');
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', 'QR-код для приложения-аутентификатора');
    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', String(n));
    bg.setAttribute('height', String(n));
    bg.setAttribute('fill', '#ffffff');
    el.append(bg);
    let d = '';
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.modules[y][x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', '#000000');
    el.append(path);
    return el;
  }

  const api = Object.freeze({ encode, svg });
  if (typeof window !== 'undefined') window.BuhQR = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
