/**
 * VIVIMUSIC WEB — romanize.js
 *
 * Offline romanization for lyrics:
 *   Korean (Revised Romanization, with the usual sound changes)
 *   Japanese kana (Hepburn)           — kanji need the online helper below
 *   Hindi / Devanagari  (lyric-style, with schwa deletion)
 *   Punjabi / Gurmukhi  (lyric-style, with schwa deletion)
 *   Chinese             (pinyin with tone marks, via vendor/pinyin-pro)
 *   Georgian            (spelling is phonetic, so letter-for-letter = as heard)
 *
 * Everything is exposed on window.__viviRoman. The core works on a string and
 * returns one output string per UTF-16 code unit of the input ("aligned"), so
 * a word / syllable timing unit can be romanized in place and keep its timing.
 */
(() => {
  'use strict';

  // ── script classification ────────────────────────────────────────────────
  function scriptOf(code) {
    if ((code >= 0xac00 && code <= 0xd7a3) || (code >= 0x3131 && code <= 0x318e)) return 'ko';
    if ((code >= 0x3041 && code <= 0x3096) || (code >= 0x30a1 && code <= 0x30fa) ||
        code === 0x30fc || (code >= 0x31f0 && code <= 0x31ff) || code === 0x30f4) return 'kana';
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || code === 0x3005 ||
        (code >= 0xf900 && code <= 0xfaff)) return 'han';
    if (code >= 0x0900 && code <= 0x097f) return 'deva';
    if (code >= 0x0a00 && code <= 0x0a7f) return 'guru';
    if ((code >= 0x10d0 && code <= 0x10fa) || (code >= 0x1c90 && code <= 0x1cba)) return 'geor';
    return 'x';
  }

  // ── Korean ───────────────────────────────────────────────────────────────
  const K_INIT = ['g','kk','n','d','tt','r','m','b','pp','s','ss','','j','jj','ch','k','t','p','h'];
  const K_INIT_JAMO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  const K_VOWEL = ['a','ae','ya','yae','eo','e','yeo','ye','o','wa','wae','oe','yo','u','wo','we','wi','yu','eu','ui','i'];
  // final index -> jamo (index 0 = none)
  const K_FINAL = ['', 'ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
  // consonant jamo as an *initial* sound
  const K_AS_INIT = { 'ㄱ':'g','ㄲ':'kk','ㅋ':'k','ㄷ':'d','ㅌ':'t','ㅅ':'s','ㅆ':'ss','ㅈ':'j','ㅊ':'ch','ㄴ':'n','ㄹ':'r','ㅁ':'m','ㅂ':'b','ㅍ':'p','ㅇ':'','ㅎ':'' };
  // representative (neutralised) coda
  const K_REP = { 'ㄱ':'ㄱ','ㅋ':'ㄱ','ㄲ':'ㄱ','ㄳ':'ㄱ','ㄺ':'ㄱ',
    'ㄴ':'ㄴ','ㄵ':'ㄴ','ㄶ':'ㄴ',
    'ㄷ':'ㄷ','ㅅ':'ㄷ','ㅆ':'ㄷ','ㅈ':'ㄷ','ㅊ':'ㄷ','ㅌ':'ㄷ','ㅎ':'ㄷ',
    'ㄹ':'ㄹ','ㄼ':'ㄹ','ㄽ':'ㄹ','ㄾ':'ㄹ','ㅀ':'ㄹ',
    'ㅁ':'ㅁ','ㄻ':'ㅁ','ㅂ':'ㅂ','ㅍ':'ㅂ','ㅄ':'ㅂ','ㄿ':'ㅂ','ㅇ':'ㅇ' };
  const K_REP_LETTER = { 'ㄱ':'k','ㄴ':'n','ㄷ':'t','ㄹ':'l','ㅁ':'m','ㅂ':'p','ㅇ':'ng' };
  // double coda -> [stays, moves to next syllable when a vowel follows]
  const K_SPLIT = { 'ㄳ':['ㄱ','ㅅ'],'ㄵ':['ㄴ','ㅈ'],'ㄶ':['ㄴ','ㅎ'],'ㄺ':['ㄹ','ㄱ'],'ㄻ':['ㄹ','ㅁ'],
    'ㄼ':['ㄹ','ㅂ'],'ㄽ':['ㄹ','ㅅ'],'ㄾ':['ㄹ','ㅌ'],'ㄿ':['ㄹ','ㅍ'],'ㅀ':['ㄹ','ㅎ'],'ㅄ':['ㅂ','ㅅ'] };
  const K_COMPAT_C = { 'ㄱ':'g','ㄲ':'kk','ㄴ':'n','ㄷ':'d','ㄸ':'tt','ㄹ':'r','ㅁ':'m','ㅂ':'b','ㅃ':'pp','ㅅ':'s','ㅆ':'ss',
    'ㅇ':'ng','ㅈ':'j','ㅉ':'jj','ㅊ':'ch','ㅋ':'k','ㅌ':'t','ㅍ':'p','ㅎ':'h' };
  const K_COMPAT_V = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';

  // run: string of Hangul syllables / jamo. returns array (one output per char)
  function romanizeHangulRun(run) {
    const n = run.length;
    const out = new Array(n).fill('');
    const syl = [];
    for (let i = 0; i < n; i++) {
      const c = run.charCodeAt(i);
      if (c >= 0xac00 && c <= 0xd7a3) {
        const s = c - 0xac00;
        const L = Math.floor(s / 588), V = Math.floor((s % 588) / 28), T = s % 28;
        syl.push({ i, init: K_INIT_JAMO[L], initStr: K_INIT[L], vowel: K_VOWEL[V], fin: K_FINAL[T] });
      } else {
        const ch = run[i];
        const ci = K_COMPAT_V.indexOf(ch);
        out[i] = ci >= 0 ? K_VOWEL[ci] : (K_COMPAT_C[ch] || ch);
        syl.push({ i, lone: true });
      }
    }
    for (const s of syl) {
      if (s.lone) continue;
      s.finJamo = s.fin;   // may be rewritten below
    }
    for (let k = 0; k < syl.length - 1; k++) {
      const a = syl[k], b = syl[k + 1];
      if (a.lone || b.lone || b.i !== a.i + 1 || !a.finJamo) continue;
      const bInit = b.init;
      if (bInit === 'ㅇ') {
        // liaison: the coda moves in front of the vowel
        if (a.finJamo === 'ㅇ') continue;
        let moved;
        if (K_SPLIT[a.finJamo]) { moved = K_SPLIT[a.finJamo][1]; a.finJamo = K_SPLIT[a.finJamo][0]; }
        else { moved = a.finJamo; a.finJamo = ''; }
        if (moved === 'ㅎ') { b.initStr = ''; continue; }
        // palatalisation before 이: 같이 -> gachi
        if (b.vowel === 'i' && (moved === 'ㄷ' || moved === 'ㅌ')) b.initStr = moved === 'ㄷ' ? 'j' : 'ch';
        else b.initStr = K_AS_INIT[moved] || '';
        continue;
      }
      // coda + ㅎ  /  ㅎ-type coda + plain stop: aspiration
      const hCoda = a.finJamo === 'ㅎ' || a.finJamo === 'ㄶ' || a.finJamo === 'ㅀ';
      if (hCoda && (bInit === 'ㄱ' || bInit === 'ㄷ' || bInit === 'ㅈ')) {
        b.initStr = { 'ㄱ':'k','ㄷ':'t','ㅈ':'ch' }[bInit];
        a.finJamo = a.finJamo === 'ㄶ' ? 'ㄴ' : a.finJamo === 'ㅀ' ? 'ㄹ' : '';
        continue;
      }
      if (bInit === 'ㅎ') {
        const rep0 = K_REP[a.finJamo];
        if (rep0 === 'ㄱ' || rep0 === 'ㄷ' || rep0 === 'ㅂ' || a.finJamo === 'ㅈ' || a.finJamo === 'ㅊ') {
          const asp = a.finJamo === 'ㅈ' || a.finJamo === 'ㅊ' ? 'ch' : { 'ㄱ':'k','ㄷ':'t','ㅂ':'p' }[rep0];
          b.initStr = asp;
          a.finJamo = '';
          continue;
        }
      }
      // consonant assimilation on the neutralised coda
      let rep = K_REP[a.finJamo];
      if (!rep) continue;
      if ((rep === 'ㄱ' || rep === 'ㄷ' || rep === 'ㅂ') && (bInit === 'ㄴ' || bInit === 'ㅁ')) {
        rep = { 'ㄱ':'ㅇ','ㄷ':'ㄴ','ㅂ':'ㅁ' }[rep];
      } else if ((rep === 'ㄱ' || rep === 'ㄷ' || rep === 'ㅂ') && bInit === 'ㄹ') {
        rep = { 'ㄱ':'ㅇ','ㄷ':'ㄴ','ㅂ':'ㅁ' }[rep];
        b.initStr = 'n';
      } else if ((rep === 'ㅁ' || rep === 'ㅇ') && bInit === 'ㄹ') {
        b.initStr = 'n';
      } else if (rep === 'ㄴ' && bInit === 'ㄹ') {
        rep = 'ㄹ';
        b.initStr = 'l';
      } else if (rep === 'ㄹ' && bInit === 'ㄴ') {
        b.initStr = 'l';
      }
      a.finJamo = rep;
    }
    for (const s of syl) {
      if (s.lone) continue;
      let fin = '';
      if (s.finJamo) {
        const rep = K_REP[s.finJamo] || s.finJamo;
        fin = K_REP_LETTER[rep] || '';
      }
      out[s.i] = s.initStr + s.vowel + fin;
    }
    return out;
  }

  // ── Japanese kana (Hepburn) ──────────────────────────────────────────────
  const KANA_BASE = {
    'あ':'a','い':'i','う':'u','え':'e','お':'o',
    'か':'ka','き':'ki','く':'ku','け':'ke','こ':'ko',
    'さ':'sa','し':'shi','す':'su','せ':'se','そ':'so',
    'た':'ta','ち':'chi','つ':'tsu','て':'te','と':'to',
    'な':'na','に':'ni','ぬ':'nu','ね':'ne','の':'no',
    'は':'ha','ひ':'hi','ふ':'fu','へ':'he','ほ':'ho',
    'ま':'ma','み':'mi','む':'mu','め':'me','も':'mo',
    'や':'ya','ゆ':'yu','よ':'yo',
    'ら':'ra','り':'ri','る':'ru','れ':'re','ろ':'ro',
    'わ':'wa','ゐ':'i','ゑ':'e','を':'o','ん':'n',
    'が':'ga','ぎ':'gi','ぐ':'gu','げ':'ge','ご':'go',
    'ざ':'za','じ':'ji','ず':'zu','ぜ':'ze','ぞ':'zo',
    'だ':'da','ぢ':'ji','づ':'zu','で':'de','ど':'do',
    'ば':'ba','び':'bi','ぶ':'bu','べ':'be','ぼ':'bo',
    'ぱ':'pa','ぴ':'pi','ぷ':'pu','ぺ':'pe','ぽ':'po',
    'ゔ':'vu','ゕ':'ka','ゖ':'ke',
    'ぁ':'a','ぃ':'i','ぅ':'u','ぇ':'e','ぉ':'o',
  };
  const SMALL_Y = { 'ゃ':'a','ゅ':'u','ょ':'o' };
  const SMALL_V = { 'ぁ':'a','ぃ':'i','ぅ':'u','ぇ':'e','ぉ':'o' };
  const KANA_COMBO = {
    'てぃ':'ti','でぃ':'di','とぅ':'tu','どぅ':'du','ふぁ':'fa','ふぃ':'fi','ふぇ':'fe','ふぉ':'fo','ふゅ':'fyu',
    'うぃ':'wi','うぇ':'we','うぉ':'wo','ゔぁ':'va','ゔぃ':'vi','ゔぇ':'ve','ゔぉ':'vo','ゔゅ':'vyu',
    'つぁ':'tsa','つぃ':'tsi','つぇ':'tse','つぉ':'tso','いぇ':'ye','くぁ':'kwa','くぃ':'kwi','くぇ':'kwe','くぉ':'kwo',
    'ぐぁ':'gwa','すぃ':'si','ずぃ':'zi',
  };
  const VOWELS = 'aiueo';

  function toHiragana(ch) {
    const c = ch.charCodeAt(0);
    if (c >= 0x30a1 && c <= 0x30f6) return String.fromCharCode(c - 0x60);
    if (c === 0x30f4) return 'ゔ';
    if (c >= 0x31f0 && c <= 0x31ff) {
      // small katakana extensions (ㇰ ㇱ ...) — map the common ones
      return ({ 0x31f0:'く',0x31f1:'し',0x31f2:'す',0x31f3:'と',0x31f4:'ぬ',0x31f5:'は',0x31f6:'ひ',0x31f7:'ふ',0x31f8:'へ',
        0x31f9:'ほ',0x31fa:'む',0x31fb:'ら',0x31fc:'り',0x31fd:'る',0x31fe:'れ',0x31ff:'ろ' })[c] || ch;
    }
    return ch;
  }

  function romanizeKanaRun(run, fullText, runStart) {
    const n = run.length;
    const out = new Array(n).fill('');
    const hira = [...run].map(toHiragana);
    let geminate = false;
    const isBoundary = (idx) => {
      // is the char after run[idx] a word boundary (space / punctuation / end)?
      const j = idx + 1;
      if (j < n) return false;
      const nx = fullText[runStart + j];
      return nx === undefined || /[\s.,!?、。！？…\-—~"')\]）」』]/.test(nx);
    };
    for (let i = 0; i < n; i++) {
      const ch = hira[i];
      const orig = run[i];
      if (orig === 'ー') {
        // long vowel mark: repeat the previous vowel
        let k = i - 1;
        while (k >= 0 && out[k] === '') k--;
        const prev = k >= 0 ? out[k] : '';
        const last = prev.slice(-1);
        out[i] = VOWELS.includes(last) ? last : '';
        continue;
      }
      if (ch === 'っ') { geminate = true; continue; }
      if (SMALL_Y[ch] !== undefined || SMALL_V[ch] !== undefined) {
        // stray small kana with nothing to attach to
        out[i] = SMALL_Y[ch] ? 'y' + SMALL_Y[ch] : SMALL_V[ch];
        continue;
      }
      let rom;
      let consumed = 0;
      const next = hira[i + 1];
      if (next && KANA_COMBO[ch + next]) { rom = KANA_COMBO[ch + next]; consumed = 1; }
      else if (next && SMALL_Y[next] && KANA_BASE[ch] && KANA_BASE[ch].endsWith('i') && ch !== 'い') {
        const base = KANA_BASE[ch];
        const stem = base.slice(0, -1);
        const v = SMALL_Y[next];
        rom = /(sh|ch|j)$/.test(stem) ? stem + v : stem + 'y' + v;
        consumed = 1;
      } else if (next && SMALL_V[next] && KANA_BASE[ch] && KANA_BASE[ch].endsWith('i') && ch !== 'い') {
        const stem = KANA_BASE[ch].slice(0, -1);
        rom = (/(sh|ch|j)$/.test(stem) ? stem : stem + 'y') + SMALL_V[next];
        consumed = 1;
      } else if (ch === 'は' && isBoundary(i)) rom = 'wa';
      else if (ch === 'へ' && isBoundary(i)) rom = 'e';
      else if (ch === 'ん') {
        const nx = hira[i + 1];
        rom = nx && /[あいうえおやゆよ]/.test(nx) ? "n'" : 'n';
      } else rom = KANA_BASE[ch];
      if (rom === undefined) { out[i] = orig; geminate = false; continue; }
      if (geminate) {
        if (rom.startsWith('ch')) rom = 't' + rom;
        else if (!VOWELS.includes(rom[0]) && rom[0] !== 'n') rom = rom[0] + rom;
        else if (rom[0] === 'n' && rom !== "n'" && rom !== 'n') rom = rom[0] + rom;
        geminate = false;
      }
      out[i] = rom;
      i += consumed;
    }
    return out;
  }

  // ── Indic scripts (Devanagari / Gurmukhi) ────────────────────────────────
  const INDIC = {
    deva: {
      cons: { 'क':'k','ख':'kh','ग':'g','घ':'gh','ङ':'ng','च':'ch','छ':'chh','ज':'j','झ':'jh','ञ':'ny',
        'ट':'t','ठ':'th','ड':'d','ढ':'dh','ण':'n','त':'t','थ':'th','द':'d','ध':'dh','न':'n',
        'प':'p','फ':'ph','ब':'b','भ':'bh','म':'m','य':'y','र':'r','ल':'l','ळ':'l','व':'v',
        'श':'sh','ष':'sh','स':'s','ह':'h',
        'क़':'q','ख़':'kh','ग़':'g','ज़':'z','ड़':'r','ढ़':'rh','फ़':'f','य़':'y' },
      nukta: '\u093c',
      composed: { '\u0958':'क़','\u0959':'ख़','\u095a':'ग़','\u095b':'ज़','\u095c':'ड़','\u095d':'ढ़','\u095e':'फ़','\u095f':'य़' },
      virama: '\u094d',
      indep: { 'अ':'a','आ':'aa','इ':'i','ई':'i','उ':'u','ऊ':'u','ऋ':'ri','ए':'e','ऐ':'ai','ओ':'o','औ':'au','ऑ':'o','ऍ':'e' },
      matra: { '\u093e':'aa','\u093f':'i','\u0940':'i','\u0941':'u','\u0942':'u','\u0943':'ri','\u0947':'e','\u0948':'ai',
        '\u094b':'o','\u094c':'au','\u0949':'o','\u0945':'e' },
      anusvara: ['\u0902'], chandra: ['\u0901'], visarga: ['\u0903'], addak: [],
      digits: '०१२३४५६७८९',
      punct: { '।':'.', '॥':'.' },
    },
    guru: {
      cons: { 'ਕ':'k','ਖ':'kh','ਗ':'g','ਘ':'gh','ਙ':'ng','ਚ':'ch','ਛ':'chh','ਜ':'j','ਝ':'jh','ਞ':'ny',
        'ਟ':'t','ਠ':'th','ਡ':'d','ਢ':'dh','ਣ':'n','ਤ':'t','ਥ':'th','ਦ':'d','ਧ':'dh','ਨ':'n',
        'ਪ':'p','ਫ':'ph','ਬ':'b','ਭ':'bh','ਮ':'m','ਯ':'y','ਰ':'r','ਲ':'l','ਵ':'v','ੜ':'r',
        'ਸ':'s','ਹ':'h','ਸ਼':'sh','ਖ਼':'kh','ਗ਼':'g','ਜ਼':'z','ਫ਼':'f','ਲ਼':'l' },
      nukta: '\u0a3c',
      // Single-code-point forms (NFC leaves these decomposed, so lyrics often carry
      // them as-is): ਸ਼ U+0A36 and ਲ਼ U+0A33 were missing here, so they stayed unromanized.
      composed: { '\u0a59':'ਖ਼','\u0a5a':'ਗ਼','\u0a5b':'ਜ਼','\u0a5c':'ੜ','\u0a5e':'ਫ਼',
        '\u0a33':'\u0a32\u0a3c', '\u0a36':'\u0a38\u0a3c' },
      virama: '\u0a4d',
      indep: { 'ਅ':'a','ਆ':'aa','ਇ':'i','ਈ':'i','ਉ':'u','ਊ':'u','ਏ':'e','ਐ':'ai','ਓ':'o','ਔ':'au',
        'ੳ':'u','ੲ':'i' },
      matra: { '\u0a3e':'aa','\u0a3f':'i','\u0a40':'i','\u0a41':'u','\u0a42':'u','\u0a47':'e','\u0a48':'ai','\u0a4b':'o','\u0a4c':'au' },
      anusvara: ['\u0a02', '\u0a70'], chandra: [], visarga: ['\u0a03'], addak: ['\u0a71'],
      digits: '੦੧੨੩੪੫੬੭੮੯',
      punct: { '।':'.', '॥':'.' },
    },
  };

  function romanizeIndicRun(run, kind) {
    const T = INDIC[kind];
    const n = run.length;
    const out = new Array(n).fill('');
    // word = maximal stretch without whitespace/punct (the run is already script-only,
    // but danda / digits / punctuation split it)
    let i = 0;
    const words = []; // each: array of aksharas
    let cur = [];
    const flush = () => { if (cur.length) { words.push(cur); cur = []; } };
    const consAt = (p) => {
      let ch = run[p];
      if (T.composed[ch]) ch = T.composed[ch];
      if (T.cons[ch] === undefined) return null;
      let len = 1;
      if (run[p + 1] === T.nukta) {
        const comb = ch + T.nukta;
        // precomposed lookups use the NFC form, e.g. ਸ + ਼ -> ਸ਼
        const norm = comb.normalize('NFC');
        if (T.cons[norm] !== undefined) { ch = norm; }
        else if (T.cons[comb] !== undefined) { ch = comb; }
        len = 2;
      }
      return { rom: T.cons[ch], len };
    };
    while (i < n) {
      const ch = run[i];
      const dIdx = T.digits.indexOf(ch);
      if (dIdx >= 0) { flush(); out[i] = String(dIdx); i++; continue; }
      if (T.punct[ch]) { flush(); out[i] = T.punct[ch]; i++; continue; }
      const c0 = consAt(i);
      if (c0) {
        const ak = { head: i, cluster: [c0.rom], vowel: null, halant: false, coda: '', pendGem: false, deleted: false, cons: true };
        let p = i + c0.len;
        // conjunct chain
        while (run[p] === T.virama) {
          const c1 = consAt(p + 1);
          if (c1) { ak.cluster.push(c1.rom); p += 1 + c1.len; }
          else { ak.halant = true; p += 1; break; }
        }
        if (!ak.halant) {
          if (T.matra[run[p]] !== undefined) { ak.vowel = T.matra[run[p]]; p++; }
        }
        // modifiers
        for (;;) {
          const m = run[p];
          if (T.anusvara.includes(m)) { ak.coda += 'n'; ak.codaSoft = true; p++; }
          else if (T.chandra.includes(m)) { ak.coda += 'n'; p++; }
          else if (T.visarga.includes(m)) { ak.coda += 'h'; p++; }
          else if (T.addak.includes(m)) { ak.pendGem = true; p++; }
          else if (m === T.nukta) { p++; }
          else break;
        }
        // ज्ञ conjunct reads "gy"
        if (kind === 'deva' && ak.cluster.length === 2 && ak.cluster[0] === 'j' && ak.cluster[1] === 'ny') ak.cluster = ['gy'];
        ak.end = p;
        cur.push(ak);
        i = p;
        continue;
      }
      if (T.indep[ch] !== undefined) {
        const ak = { head: i, cluster: [], vowel: T.indep[ch], halant: false, coda: '', pendGem: false, cons: false };
        let p = i + 1;
        // gurmukhi carriers: ਅ/ੳ/ੲ + matra
        if ((ch === 'ਅ' || ch === 'ੳ' || ch === 'ੲ') && T.matra[run[p]] !== undefined) { ak.vowel = T.matra[run[p]]; p++; }
        for (;;) {
          const m = run[p];
          if (T.anusvara.includes(m)) { ak.coda += 'n'; ak.codaSoft = true; p++; }
          else if (T.chandra.includes(m)) { ak.coda += 'n'; p++; }
          else if (T.visarga.includes(m)) { ak.coda += 'h'; p++; }
          else if (T.addak.includes(m)) { ak.pendGem = true; p++; }
          else break;
        }
        ak.end = p;
        cur.push(ak);
        i = p;
        continue;
      }
      // stray sign / unknown char
      flush();
      out[i] = T.matra[ch] || ch;
      i++;
    }
    flush();

    // schwa deletion per word
    for (const w of words) {
      const m = w.length;
      for (const a of w) a.inherent = a.cons && !a.halant && a.vowel === null;
      if (m > 1) {
        const last = w[m - 1];
        if (last.inherent && !last.coda) last.deleted = true;
      }
      for (let k = m - 2; k >= 1; k--) {
        const a = w[k];
        if (!a.inherent || a.deleted || a.cluster.length !== 1 || a.coda) continue;
        const prev = w[k - 1], next = w[k + 1];
        const prevOk = !prev.halant && !prev.coda && !(prev.inherent && prev.deleted);
        const nextOk = !next.halant && !(next.inherent && next.deleted) && next.cluster.length <= 1;
        if (prevOk && nextOk) a.deleted = true;
      }
      let gem = false;
      for (let k = 0; k < m; k++) {
        const a = w[k];
        let onset = a.cluster.join('');
        if (gem && onset) { onset = onset[0] + onset; gem = false; }
        let v = a.vowel !== null ? a.vowel : (a.inherent && !a.deleted ? 'a' : '');
        // word-final long ā reads as a plain "a" in lyric romanization (mera, kya)
        // ...but a word that is just the vowel letter itself (ਆ / आ, "come") keeps "aa".
        if (v === 'aa' && k === m - 1 && !a.coda && !(m === 1 && !a.cons)) v = 'a';
        let coda = a.coda;
        if (coda && a.codaSoft) {
          const nx = w[k + 1];
          if (nx && /^(p|b|m|ph|bh)/.test(nx.cluster.join(''))) coda = coda.replace(/n/g, 'm');
        }
        if (a.pendGem) gem = true;
        out[a.head] = onset + v + coda;
      }
    }
    return out;
  }

  // ── Chinese ──────────────────────────────────────────────────────────────
  function romanizeHanRun(run) {
    const out = new Array(run.length).fill('');
    const P = (typeof globalThis !== 'undefined' && globalThis.pinyinPro) || null;
    if (!P || !P.pinyin) return null;
    let items;
    try { items = P.pinyin(run, { type: 'all', toneType: 'symbol' }); } catch { return null; }
    let pos = 0;
    for (const it of items) {
      const o = it.origin || '';
      if (it.isZh && it.pinyin) out[pos] = it.pinyin + ' ';
      else out[pos] = o;
      pos += o.length;
      // keep alignment even when pinyin-pro merges characters
      for (let k = 1; k < o.length && pos - o.length + k < out.length; k++) out[pos - o.length + k] = '';
    }
    return out;
  }

  // ── Georgian ─────────────────────────────────────────────────────────────
  // Georgian spelling is phonetic: one letter, one sound. Ejective/aspirated pairs
  // (კ/ქ, ტ/თ, პ/ფ, წ/ც, ჭ/ჩ) sound alike to an English reader, so no apostrophes.
  const KA_MAP = { 'ა':'a','ბ':'b','გ':'g','დ':'d','ე':'e','ვ':'v','ზ':'z','თ':'t','ი':'i','კ':'k','ლ':'l','მ':'m',
    'ნ':'n','ო':'o','პ':'p','ჟ':'zh','რ':'r','ს':'s','ტ':'t','უ':'u','ფ':'p','ქ':'k','ღ':'gh','ყ':'q','შ':'sh',
    'ჩ':'ch','ც':'ts','ძ':'dz','წ':'ts','ჭ':'ch','ხ':'kh','ჯ':'j','ჰ':'h' };
  function romanizeGeorgianRun(run) {
    const out = new Array(run.length);
    for (let i = 0; i < run.length; i++) {
      let c = run.charCodeAt(i);
      let up = false;
      if (c >= 0x1c90 && c <= 0x1cba) { c = c - 0x1c90 + 0x10d0; up = true; }   // Mtavruli -> Mkhedruli
      const m = KA_MAP[String.fromCharCode(c)];
      out[i] = m === undefined ? run[i] : (up ? m.toUpperCase() : m);
    }
    return out;
  }

  // ── full-text, aligned ───────────────────────────────────────────────────
  const PUNCT_MAP = { '，':', ','。':'. ','！':'! ','？':'? ','、':', ','：':': ','；':'; ','（':' (','）':') ',
    '「':' "','」':'" ','『':' "','』':'" ','“':'"','”':'"','・':' ','～':'~','　':' ' };

  const LANG_OF_SCRIPT = { ko: 'ko', kana: 'ja', deva: 'hi', guru: 'pa', geor: 'ka' };
  // Languages that can be switched on / off (ids are stored in settings.lyricsRomanLangs)
  const LANGS = [
    { id: 'ko', name: 'Korean' }, { id: 'ja', name: 'Japanese' }, { id: 'zh', name: 'Chinese' },
    { id: 'hi', name: 'Hindi' }, { id: 'pa', name: 'Punjabi' }, { id: 'ka', name: 'Georgian' },
  ];

  // Scripts that are NOT converted offline: the sound-alike Latin spelling is
  // fetched from Google Translate's transliteration (nothing is translated).
  // Only lines in these scripts are sent, one line at a time.
  const ONLINE_SCRIPTS = [
    ['bn', /\p{Script=Bengali}/u], ['ta', /\p{Script=Tamil}/u], ['te', /\p{Script=Telugu}/u],
    ['gu', /\p{Script=Gujarati}/u], ['kn', /\p{Script=Kannada}/u], ['ml', /\p{Script=Malayalam}/u],
    ['or', /\p{Script=Oriya}/u], ['si', /\p{Script=Sinhala}/u], ['ar', /\p{Script=Arabic}/u],
    ['he', /\p{Script=Hebrew}/u], ['ru', /\p{Script=Cyrillic}/u], ['el', /\p{Script=Greek}/u],
    ['th', /\p{Script=Thai}/u],
  ];
  // -> language id when this line has an online-romanized script that is switched on, else null
  function onlineLangOf(text, ctx) {
    const t = String(text || '');
    if (!t) return null;
    for (const [id, re] of ONLINE_SCRIPTS) {
      if ((!ctx || !ctx.langs || ctx.langs.has(id)) && re.test(t)) return id;
    }
    return null;
  }

  // returns { out: string[], changed, unresolvedHan, scripts:Set }
  function romanizeAligned(text, ctx) {
    ctx = ctx || {};
    const n = text.length;
    const out = new Array(n);
    const scripts = new Set();
    let changed = false, unresolvedHan = false;
    let i = 0;
    while (i < n) {
      const sc = scriptOf(text.charCodeAt(i));
      let j = i + 1;
      if (sc !== 'x') {
        while (j < n && scriptOf(text.charCodeAt(j)) === sc) j++;
        // a long-vowel mark / iteration mark glued to han/kana belongs to the kana run: handled by scriptOf
      } else {
        while (j < n && scriptOf(text.charCodeAt(j)) === 'x') j++;
      }
      const run = text.slice(i, j);
      let res = null;
      const lang = LANG_OF_SCRIPT[sc] || (sc === 'han' ? (ctx.hasKana ? 'ja' : 'zh') : null);
      const enabled = !!lang && (!ctx.langs || ctx.langs.has(lang));
      if (enabled) {
        if (sc === 'ko') res = romanizeHangulRun(run);
        else if (sc === 'kana') res = romanizeKanaRun(run, text, i);
        else if (sc === 'deva' || sc === 'guru') res = romanizeIndicRun(run, sc);
        else if (sc === 'geor') res = romanizeGeorgianRun(run);
        else if (sc === 'han') {
          if (ctx.hasKana) { unresolvedHan = true; res = null; }
          else res = romanizeHanRun(run);
        }
      }
      if (res) {
        scripts.add(sc);
        changed = true;
        for (let k = 0; k < run.length; k++) out[i + k] = res[k];
      } else {
        if (sc === 'han') scripts.add('ja-han');
        for (let k = 0; k < run.length; k++) {
          const ch = run[k];
          out[i + k] = sc === 'x' && PUNCT_MAP[ch] !== undefined ? PUNCT_MAP[ch] : ch;
        }
      }
      i = j;
    }
    return { out, changed, unresolvedHan, scripts };
  }

  function tidy(s) {
    return s.replace(/\s+([,.!?;:])/g, '$1').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s{2,}/g, ' ').trim();
  }

  // Song-level context: Han characters in a song that also has kana are Japanese
  // (kanji), otherwise Chinese.
  function analyzeSong(lines) {
    const ctx = { hasKana: false, hasHan: false };
    for (const l of lines || []) {
      const t = l.text || '';
      for (let i = 0; i < t.length; i++) {
        const s = scriptOf(t.charCodeAt(i));
        if (s === 'kana') ctx.hasKana = true;
        else if (s === 'han') ctx.hasHan = true;
      }
      if (ctx.hasKana) break;
    }
    return ctx;
  }

  // Whole-line romanization. -> { text, unresolvedHan } | null (nothing to romanize)
  function romanizeLine(text, ctx) {
    const r = romanizeAligned(text, ctx);
    if (!r.changed && !r.unresolvedHan) return null;
    const s = tidy(r.out.join(''));
    return { text: s, unresolvedHan: r.unresolvedHan, onlyKanji: r.unresolvedHan && !r.changed };
  }

  // Romanize timing units while keeping them separate.
  // units: [{ text, sep }]  sep = string put in front of the unit in the line
  // returns { units: string[], wordSpaced: bool, any: bool, unresolvedHan }
  function romanizeUnits(units, ctx) {
    let full = '';
    const offs = [];
    for (const u of units) {
      full += u.sep || '';
      offs.push([full.length, full.length + u.text.length]);
      full += u.text;
    }
    const r = romanizeAligned(full, ctx);
    if (!r.changed) return { units: null, any: false, unresolvedHan: r.unresolvedHan };
    const res = units.map((_, k) => tidy(r.out.slice(offs[k][0], offs[k][1]).join('')));
    const hanZh = r.scripts.has('han');
    return { units: res, any: true, unresolvedHan: r.unresolvedHan, spaced: hanZh };
  }

  // ── online helper for kanji (Japanese) ───────────────────────────────────
  const onlineCache = new Map();
  const onlineQueue = [];
  let onlineActive = 0;
  const ONLINE_MAX = 4;

  function pumpOnline() {
    while (onlineActive < ONLINE_MAX && onlineQueue.length) {
      const job = onlineQueue.shift();
      onlineActive++;
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        onlineActive--;
        if (val) onlineCache.set(job.text, val);
        job.resolve(val || null);
        pumpOnline();
      };
      try {
        // Japanese text is looked up as Japanese; every other script lets Google detect it.
        const sl = /[\u3040-\u30ff\u3400-\u9fff]/.test(job.text) ? 'ja' : 'auto';
        chrome.runtime.sendMessage({ type: 'VIVI_ROMANIZE_JA', text: job.text, sl }, (resp) => {
          void chrome.runtime.lastError;
          finish(resp && resp.ok && resp.text ? resp.text : null);
        });
      } catch { finish(null); }
      setTimeout(() => finish(null), 8000);
    }
  }


  // Spread an online romanization of a whole line back over the original timing
  // units, so word / syllable highlighting keeps working exactly like the original
  // lyrics. Kana have an exact offline romaji, so they are located inside the online
  // romaji and act as anchors; kanji share whatever lies between two anchors.
  // units: [{ text }]  ->  [{ text, spaceAfter }] | null
  function splitRomanByUnits(online, units) {
    const s = String(online || '').replace(/\s+/g, ' ').trim();
    if (!s || !units || !units.length) return null;
    const isLetter = (ch) => /[\p{L}\p{N}]/u.test(ch);
    const idxs = [];            // positions in s of letters/digits
    let L = '';                 // the same letters, lower-cased and de-accented
    for (let i = 0; i < s.length; i++) {
      if (isLetter(s[i])) { idxs.push(i); L += s[i].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')[0] || ''; }
    }
    const tot = idxs.length;
    if (!tot) return null;

    // tokens: one per source character
    const tokens = [];          // { unit, kanji, known, start, end }
    units.forEach((u, ui) => {
      const r = romanizeAligned(u.text, { hasKana: true });
      for (let k = 0; k < u.text.length; k++) {
        const han = scriptOf(u.text.charCodeAt(k)) === 'han';
        const known = han ? '' : String(r.out[k] || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        tokens.push({ unit: ui, kanji: han, known, start: 0, end: 0 });
      }
    });

    let pos = 0;
    let pending = [];           // tokens waiting for the next anchor
    const spread = (list, from, to) => {
      const w = list.map((t) => (t.kanji ? 1 : Math.max(1, t.known.length)));
      const W = w.reduce((x, y) => x + y, 0) || 1;
      let acc = 0;
      list.forEach((t, k) => {
        t.start = from + Math.round(((to - from) * acc) / W);
        acc += w[k];
        t.end = from + Math.round(((to - from) * acc) / W);
      });
    };
    for (const t of tokens) {
      if (t.kanji) { pending.push(t); continue; }
      if (!t.known) { t.start = t.end = pos; continue; }   // small kana / sokuon: folded into a neighbour
      const maxOff = pending.length * 8;
      const at = L.indexOf(t.known, pos);
      if (at >= 0 && at - pos <= maxOff) {
        if (pending.length) { spread(pending, pos, at); pending = []; }
        t.start = at; t.end = at + t.known.length;
        pos = t.end;
      } else {
        pending.push(t);       // could not be located: treat like an unknown stretch
      }
    }
    if (pending.length) spread(pending, pos, tot);

    // unit boundaries = end of the unit's last token
    const unitEnd = new Array(units.length).fill(null);
    tokens.forEach((t) => { unitEnd[t.unit] = Math.max(unitEnd[t.unit] == null ? 0 : unitEnd[t.unit], t.end); });
    let prevEnd = 0;
    const cuts = unitEnd.map((e, i) => {
      let v = e == null ? prevEnd : e;
      v = Math.min(tot, Math.max(prevEnd, v));
      prevEnd = v;
      return i === units.length - 1 ? tot : v;
    });
    const at = (p) => (p >= tot ? s.length : idxs[p]);
    const res = [];
    let start = 0;
    for (const end of cuts) {
      const raw = start >= end ? '' : s.slice(at(start), at(end));
      res.push({ text: raw.trim(), spaceAfter: /\s$/.test(raw) });
      start = end;
    }
    return res;
  }

  const onlineInflight = new Map();
  function romanizeJapaneseOnline(text) {
    if (onlineCache.has(text)) return Promise.resolve(onlineCache.get(text));
    if (onlineInflight.has(text)) return onlineInflight.get(text);
    const p = new Promise((resolve) => { onlineQueue.push({ text, resolve }); pumpOnline(); })
      .then((v) => { onlineInflight.delete(text); return v; });
    onlineInflight.set(text, p);
    return p;
  }

  window.__viviRoman = {
    scriptOf,
    analyzeSong,
    romanizeAligned,
    romanizeLine,
    romanizeUnits,
    romanizeJapaneseOnline,
    onlineLangOf,
    ONLINE_LANGS: ONLINE_SCRIPTS.map((x) => x[0]),
    LANGS,
    splitRomanByUnits,
    getCachedJapanese: (t) => onlineCache.get(t) || null,
    _internals: { romanizeHangulRun, romanizeKanaRun, romanizeIndicRun },
  };
})();
