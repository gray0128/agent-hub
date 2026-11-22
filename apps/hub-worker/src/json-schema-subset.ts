import { HubError } from "./types";

export const MAX_RESULT_SCHEMA_BYTES = 16384;
export const MAX_RESULT_SCHEMA_DEPTH = 16;
export const MAX_RESULT_SCHEMA_NODES = 256;
export const MAX_RESULT_SCHEMA_PATTERN_LENGTH = 256;
const MAX_VALIDATION_ERRORS = 8;

const utf8Encoder = new TextEncoder();

const ALLOWED_SCHEMA_KEYWORDS = new Set<string>([
  "$schema",
  "$id",
  "title",
  "description",
  "default",
  "examples",
  "$comment",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "minProperties",
  "maxProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "allOf",
  "anyOf",
  "oneOf"
]);

const SCHEMA_TYPES = new Set<string>([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null"
]);

const ALLOWED_FORMATS = new Set<string>(["date-time", "date", "email", "uri", "uuid"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;
const EMAIL_LOCAL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DNS_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const DECIMAL_NUM_RE = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function isPlainJsonObject(raw: unknown): raw is Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return false;
  }
  const proto = Object.getPrototypeOf(raw);
  return proto === Object.prototype || proto === null;
}

function codePointLength(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    count++;
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
      }
    }
  }
  return count;
}

interface SchemaWalkState {
  nodeCount: number;
  visiting: WeakSet<object>;
}

function assertNonNegativeInt(val: unknown, keyword: string, path: string): void {
  if (typeof val !== "number" || !Number.isSafeInteger(val) || val < 0) {
    throw new HubError(
      400,
      "BAD_REQUEST",
      `result_schema keyword '${keyword}' at ${path} must be a non-negative integer.`
    );
  }
}

function assertFiniteNumber(val: unknown, keyword: string, path: string): void {
  if (typeof val !== "number" || !Number.isFinite(val)) {
    throw new HubError(
      400,
      "BAD_REQUEST",
      `result_schema keyword '${keyword}' at ${path} must be a finite number.`
    );
  }
}

interface CharSet {
  w0: number;
  w1: number;
  w2: number;
  w3: number;
  nonAscii: boolean;
}

function emptyCharSet(): CharSet {
  return { w0: 0, w1: 0, w2: 0, w3: 0, nonAscii: false };
}

function fullCharSet(): CharSet {
  return { w0: -1, w1: -1, w2: -1, w3: -1, nonAscii: true };
}

function addCodePoint(cs: CharSet, cp: number): void {
  if (cp >= 128) {
    cs.nonAscii = true;
    return;
  }
  if (cp < 0) return;
  const word = cp >>> 5;
  const bit = 1 << (cp & 31);
  if (word === 0) cs.w0 |= bit;
  else if (word === 1) cs.w1 |= bit;
  else if (word === 2) cs.w2 |= bit;
  else cs.w3 |= bit;
}

function addCodeRange(cs: CharSet, lo: number, hi: number): void {
  const start = Math.max(0, lo);
  const asciiEnd = Math.min(127, hi);
  for (let cp = start; cp <= asciiEnd; cp++) {
    addCodePoint(cs, cp);
  }
  if (hi >= 128) {
    cs.nonAscii = true;
  }
}

function singleCharSet(cp: number): CharSet {
  const cs = emptyCharSet();
  addCodePoint(cs, cp);
  return cs;
}

function unionCharSet(a: CharSet, b: CharSet): CharSet {
  return {
    w0: a.w0 | b.w0,
    w1: a.w1 | b.w1,
    w2: a.w2 | b.w2,
    w3: a.w3 | b.w3,
    nonAscii: a.nonAscii || b.nonAscii
  };
}

function complementCharSet(cs: CharSet): CharSet {
  return {
    w0: ~cs.w0,
    w1: ~cs.w1,
    w2: ~cs.w2,
    w3: ~cs.w3,
    nonAscii: true
  };
}

function charSetsOverlap(a: CharSet, b: CharSet): boolean {
  return (
    ((a.w0 & b.w0) | (a.w1 & b.w1) | (a.w2 & b.w2) | (a.w3 & b.w3)) !== 0 ||
    (a.nonAscii && b.nonAscii)
  );
}

const DIGIT_CHAR_SET: CharSet = (() => {
  const cs = emptyCharSet();
  addCodeRange(cs, 48, 57);
  return cs;
})();
const NON_DIGIT_CHAR_SET = complementCharSet(DIGIT_CHAR_SET);

const WORD_CHAR_SET: CharSet = (() => {
  const cs = emptyCharSet();
  addCodeRange(cs, 48, 57);
  addCodeRange(cs, 65, 90);
  addCodePoint(cs, 95);
  addCodeRange(cs, 97, 122);
  return cs;
})();
const NON_WORD_CHAR_SET = complementCharSet(WORD_CHAR_SET);

const SPACE_CHAR_SET: CharSet = (() => {
  const cs = emptyCharSet();
  for (const cp of [9, 10, 11, 12, 13, 32]) {
    addCodePoint(cs, cp);
  }
  cs.nonAscii = true;
  return cs;
})();
const NON_SPACE_CHAR_SET = complementCharSet(SPACE_CHAR_SET);

const DOT_CHAR_SET: CharSet = (() => {
  const cs = emptyCharSet();
  addCodePoint(cs, 10);
  addCodePoint(cs, 13);
  return complementCharSet(cs);
})();

type RegexAstNode =
  | { kind: "atom"; cs: CharSet; zeroWidth: boolean; isBackref: boolean; isStartAnchor?: boolean }
  | { kind: "concat"; parts: RegexAstNode[] }
  | { kind: "alt"; branches: RegexAstNode[] }
  | { kind: "group"; body: RegexAstNode; zeroWidth: boolean }
  | { kind: "quant"; inner: RegexAstNode; min: number; max: number };

function parseRegexEscape(
  src: string,
  pos: number,
  inClass: boolean
): { nextPos: number; cs: CharSet; zeroWidth: boolean; isBackref: boolean; singleCp: number | null } {
  const ch = src[pos];
  if (ch === undefined) {
    return { nextPos: pos, cs: emptyCharSet(), zeroWidth: false, isBackref: false, singleCp: null };
  }
  switch (ch) {
    case "d":
      return { nextPos: pos + 1, cs: DIGIT_CHAR_SET, zeroWidth: false, isBackref: false, singleCp: null };
    case "D":
      return { nextPos: pos + 1, cs: NON_DIGIT_CHAR_SET, zeroWidth: false, isBackref: false, singleCp: null };
    case "w":
      return { nextPos: pos + 1, cs: WORD_CHAR_SET, zeroWidth: false, isBackref: false, singleCp: null };
    case "W":
      return { nextPos: pos + 1, cs: NON_WORD_CHAR_SET, zeroWidth: false, isBackref: false, singleCp: null };
    case "s":
      return { nextPos: pos + 1, cs: SPACE_CHAR_SET, zeroWidth: false, isBackref: false, singleCp: null };
    case "S":
      return { nextPos: pos + 1, cs: NON_SPACE_CHAR_SET, zeroWidth: false, isBackref: false, singleCp: null };
    case "b":
      if (inClass) {
        return { nextPos: pos + 1, cs: singleCharSet(8), zeroWidth: false, isBackref: false, singleCp: 8 };
      }
      return { nextPos: pos + 1, cs: emptyCharSet(), zeroWidth: true, isBackref: false, singleCp: null };
    case "B":
      return { nextPos: pos + 1, cs: emptyCharSet(), zeroWidth: !inClass, isBackref: false, singleCp: null };
    case "n":
      return { nextPos: pos + 1, cs: singleCharSet(10), zeroWidth: false, isBackref: false, singleCp: 10 };
    case "r":
      return { nextPos: pos + 1, cs: singleCharSet(13), zeroWidth: false, isBackref: false, singleCp: 13 };
    case "t":
      return { nextPos: pos + 1, cs: singleCharSet(9), zeroWidth: false, isBackref: false, singleCp: 9 };
    case "f":
      return { nextPos: pos + 1, cs: singleCharSet(12), zeroWidth: false, isBackref: false, singleCp: 12 };
    case "v":
      return { nextPos: pos + 1, cs: singleCharSet(11), zeroWidth: false, isBackref: false, singleCp: 11 };
    case "0":
      return { nextPos: pos + 1, cs: singleCharSet(0), zeroWidth: false, isBackref: false, singleCp: 0 };
    case "p":
    case "P": {
      if (src[pos + 1] === "{") {
        const end = src.indexOf("}", pos + 2);
        if (end !== -1) {
          return { nextPos: end + 1, cs: fullCharSet(), zeroWidth: false, isBackref: false, singleCp: null };
        }
      }
      return { nextPos: pos + 1, cs: fullCharSet(), zeroWidth: false, isBackref: false, singleCp: null };
    }
    case "x": {
      const hex = src.slice(pos + 1, pos + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        const cp = Number.parseInt(hex, 16);
        return { nextPos: pos + 3, cs: singleCharSet(cp), zeroWidth: false, isBackref: false, singleCp: cp };
      }
      break;
    }
    case "u": {
      if (src[pos + 1] === "{") {
        const end = src.indexOf("}", pos + 2);
        if (end !== -1) {
          const cp = Number.parseInt(src.slice(pos + 2, end), 16);
          if (Number.isFinite(cp)) {
            return { nextPos: end + 1, cs: singleCharSet(cp), zeroWidth: false, isBackref: false, singleCp: cp };
          }
        }
      } else {
        const hex = src.slice(pos + 1, pos + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          const cp = Number.parseInt(hex, 16);
          return { nextPos: pos + 5, cs: singleCharSet(cp), zeroWidth: false, isBackref: false, singleCp: cp };
        }
      }
      break;
    }
    case "c": {
      const ctrl = src[pos + 1];
      if (ctrl !== undefined) {
        const cp = ctrl.charCodeAt(0) % 32;
        return { nextPos: pos + 2, cs: singleCharSet(cp), zeroWidth: false, isBackref: false, singleCp: cp };
      }
      break;
    }
    case "k": {
      if (!inClass && src[pos + 1] === "<") {
        const end = src.indexOf(">", pos + 2);
        if (end !== -1) {
          return { nextPos: end + 1, cs: fullCharSet(), zeroWidth: false, isBackref: true, singleCp: null };
        }
      }
      break;
    }
  }
  if (!inClass && ch >= "1" && ch <= "9") {
    let end = pos + 1;
    while (end < src.length && src[end]! >= "0" && src[end]! <= "9") end++;
    return { nextPos: end, cs: fullCharSet(), zeroWidth: false, isBackref: true, singleCp: null };
  }
  const cp = src.codePointAt(pos) ?? 0;
  const step = cp > 0xffff ? 2 : 1;
  return { nextPos: pos + step, cs: singleCharSet(cp), zeroWidth: false, isBackref: false, singleCp: cp };
}

function parseRegexAst(src: string): RegexAstNode {
  let pos = 0;

  function parseClass(): RegexAstNode {
    pos++; // consume '['
    let negated = false;
    if (src[pos] === "^") {
      negated = true;
      pos++;
    }
    let cs = emptyCharSet();
    while (pos < src.length && src[pos] !== "]") {
      let itemCs: CharSet;
      let startCp: number | null = null;
      if (src[pos] === "\\") {
        pos++;
        const esc = parseRegexEscape(src, pos, true);
        pos = esc.nextPos;
        itemCs = esc.cs;
        startCp = esc.singleCp;
      } else {
        const cp = src.codePointAt(pos) ?? 0;
        pos += cp > 0xffff ? 2 : 1;
        itemCs = singleCharSet(cp);
        startCp = cp;
      }

      if (startCp !== null && src[pos] === "-" && pos + 1 < src.length && src[pos + 1] !== "]") {
        pos++; // consume '-'
        let endCp: number | null = null;
        if (src[pos] === "\\") {
          pos++;
          const escEnd = parseRegexEscape(src, pos, true);
          pos = escEnd.nextPos;
          endCp = escEnd.singleCp;
        } else {
          const cp = src.codePointAt(pos) ?? 0;
          pos += cp > 0xffff ? 2 : 1;
          endCp = cp;
        }
        if (endCp !== null && endCp >= startCp) {
          addCodeRange(cs, startCp, endCp);
        } else {
          cs = unionCharSet(cs, itemCs);
        }
      } else {
        cs = unionCharSet(cs, itemCs);
      }
    }
    if (src[pos] === "]") pos++;
    if (negated) cs = complementCharSet(cs);
    return { kind: "atom", cs, zeroWidth: false, isBackref: false };
  }

  function parseQuantifier(atom: RegexAstNode): RegexAstNode {
    if (pos >= src.length) return atom;
    const ch = src[pos];
    let min = -1;
    let max = -1;
    if (ch === "*") {
      min = 0;
      max = Infinity;
      pos++;
    } else if (ch === "+") {
      min = 1;
      max = Infinity;
      pos++;
    } else if (ch === "?") {
      min = 0;
      max = 1;
      pos++;
    } else if (ch === "{") {
      const m = /^\{(\d+)(?:,(\d*))?\}/.exec(src.slice(pos));
      if (m) {
        min = Number.parseInt(m[1]!, 10);
        if (m[2] === undefined) {
          max = min;
        } else if (m[2] === "") {
          max = Infinity;
        } else {
          max = Number.parseInt(m[2], 10);
        }
        pos += m[0].length;
      }
    }
    if (min === -1) return atom;
    if (src[pos] === "?") pos++; // lazy modifier
    return { kind: "quant", inner: atom, min, max };
  }

  function parseAtom(): RegexAstNode | null {
    if (pos >= src.length) return null;
    const ch = src[pos]!;
    if (ch === "|" || ch === ")") return null;
    if (ch === "(") {
      pos++;
      let zeroWidth = false;
      if (src[pos] === "?") {
        pos++;
        if (src[pos] === ":") {
          pos++;
        } else if (src[pos] === "=" || src[pos] === "!") {
          pos++;
          zeroWidth = true;
        } else if (src[pos] === "<") {
          pos++;
          if (src[pos] === "=" || src[pos] === "!") {
            pos++;
            zeroWidth = true;
          } else {
            const end = src.indexOf(">", pos);
            if (end !== -1) pos = end + 1;
          }
        }
      }
      const body = parseAlt();
      if (src[pos] === ")") pos++;
      return { kind: "group", body, zeroWidth };
    }
    if (ch === "[") {
      return parseClass();
    }
    if (ch === "\\") {
      pos++;
      const esc = parseRegexEscape(src, pos, false);
      pos = esc.nextPos;
      return { kind: "atom", cs: esc.cs, zeroWidth: esc.zeroWidth, isBackref: esc.isBackref };
    }
    if (ch === ".") {
      pos++;
      return { kind: "atom", cs: DOT_CHAR_SET, zeroWidth: false, isBackref: false };
    }
    if (ch === "^" || ch === "$") {
      pos++;
      return {
        kind: "atom",
        cs: emptyCharSet(),
        zeroWidth: true,
        isBackref: false,
        isStartAnchor: ch === "^"
      };
    }
    const cp = src.codePointAt(pos) ?? 0;
    pos += cp > 0xffff ? 2 : 1;
    return { kind: "atom", cs: singleCharSet(cp), zeroWidth: false, isBackref: false };
  }

  function parseConcat(): RegexAstNode {
    const parts: RegexAstNode[] = [];
    while (pos < src.length && src[pos] !== "|" && src[pos] !== ")") {
      const atom = parseAtom();
      if (!atom) break;
      parts.push(parseQuantifier(atom));
    }
    return parts.length === 1 ? parts[0]! : { kind: "concat", parts };
  }

  function parseAlt(): RegexAstNode {
    const branches: RegexAstNode[] = [parseConcat()];
    while (pos < src.length && src[pos] === "|") {
      pos++;
      branches.push(parseConcat());
    }
    return branches.length === 1 ? branches[0]! : { kind: "alt", branches };
  }

  return parseAlt();
}

function astMinLen(node: RegexAstNode): number {
  switch (node.kind) {
    case "atom":
      return node.zeroWidth ? 0 : 1;
    case "concat":
      return node.parts.reduce((acc, p) => acc + astMinLen(p), 0);
    case "alt":
      return Math.min(...node.branches.map(astMinLen));
    case "group":
      return node.zeroWidth ? 0 : astMinLen(node.body);
    case "quant":
      return node.min * astMinLen(node.inner);
  }
}

function astAllChars(node: RegexAstNode): CharSet {
  switch (node.kind) {
    case "atom":
      return node.zeroWidth ? emptyCharSet() : node.cs;
    case "concat":
      return node.parts.reduce((acc, p) => unionCharSet(acc, astAllChars(p)), emptyCharSet());
    case "alt":
      return node.branches.reduce((acc, b) => unionCharSet(acc, astAllChars(b)), emptyCharSet());
    case "group":
      return node.zeroWidth ? emptyCharSet() : astAllChars(node.body);
    case "quant":
      return node.max === 0 ? emptyCharSet() : astAllChars(node.inner);
  }
}

function astFirstChars(node: RegexAstNode): CharSet {
  switch (node.kind) {
    case "atom":
      return node.zeroWidth ? emptyCharSet() : node.cs;
    case "concat": {
      let cs = emptyCharSet();
      for (const p of node.parts) {
        cs = unionCharSet(cs, astFirstChars(p));
        if (astMinLen(p) > 0) break;
      }
      return cs;
    }
    case "alt":
      return node.branches.reduce((acc, b) => unionCharSet(acc, astFirstChars(b)), emptyCharSet());
    case "group":
      return node.zeroWidth ? emptyCharSet() : astFirstChars(node.body);
    case "quant":
      return node.max === 0 ? emptyCharSet() : astFirstChars(node.inner);
  }
}

function astLastChars(node: RegexAstNode): CharSet {
  switch (node.kind) {
    case "atom":
      return node.zeroWidth ? emptyCharSet() : node.cs;
    case "concat": {
      let cs = emptyCharSet();
      for (let i = node.parts.length - 1; i >= 0; i--) {
        const p = node.parts[i]!;
        cs = unionCharSet(cs, astLastChars(p));
        if (astMinLen(p) > 0) break;
      }
      return cs;
    }
    case "alt":
      return node.branches.reduce((acc, b) => unionCharSet(acc, astLastChars(b)), emptyCharSet());
    case "group":
      return node.zeroWidth ? emptyCharSet() : astLastChars(node.body);
    case "quant":
      return node.max === 0 ? emptyCharSet() : astLastChars(node.inner);
  }
}

function astHasBackref(node: RegexAstNode): boolean {
  switch (node.kind) {
    case "atom":
      return node.isBackref;
    case "concat":
      return node.parts.some(astHasBackref);
    case "alt":
      return node.branches.some(astHasBackref);
    case "group":
      return astHasBackref(node.body);
    case "quant":
      return astHasBackref(node.inner);
  }
}

function isVariableQuant(node: RegexAstNode): boolean {
  return node.kind === "quant" && (node.max > node.min || node.max === Infinity);
}

function astContainsVarQuant(node: RegexAstNode): boolean {
  switch (node.kind) {
    case "atom":
      return false;
    case "concat":
      return node.parts.some(astContainsVarQuant);
    case "alt":
      return node.branches.some(astContainsVarQuant);
    case "group":
      return astContainsVarQuant(node.body);
    case "quant":
      return isVariableQuant(node) || (node.max >= 1 && astContainsVarQuant(node.inner));
  }
}

function astContainsUnboundedQuant(node: RegexAstNode): boolean {
  switch (node.kind) {
    case "atom":
      return false;
    case "concat":
      return node.parts.some(astContainsUnboundedQuant);
    case "alt":
      return node.branches.some(astContainsUnboundedQuant);
    case "group":
      return astContainsUnboundedQuant(node.body);
    case "quant":
      return node.max === Infinity || (node.max >= 1 && astContainsUnboundedQuant(node.inner));
  }
}

function astContainsRepeatingOrVarQuant(node: RegexAstNode): boolean {
  switch (node.kind) {
    case "atom":
      return false;
    case "concat":
      return node.parts.some(astContainsRepeatingOrVarQuant);
    case "alt":
      return node.branches.length > 1 || node.branches.some(astContainsRepeatingOrVarQuant);
    case "group":
      return astContainsRepeatingOrVarQuant(node.body);
    case "quant":
      return (
        isVariableQuant(node) ||
        (node.max >= 1 && astContainsRepeatingOrVarQuant(node.inner))
      );
  }
}

function astFixedPrefixSeq(node: RegexAstNode): CharSet[] | null {
  switch (node.kind) {
    case "atom":
      return node.zeroWidth ? [] : [node.cs];
    case "concat": {
      const seq: CharSet[] = [];
      for (const p of node.parts) {
        const sub = astFixedPrefixSeq(p);
        if (!sub) return null;
        seq.push(...sub);
      }
      return seq;
    }
    case "group":
      return node.zeroWidth ? [] : astFixedPrefixSeq(node.body);
    case "quant": {
      if (node.min !== node.max || node.min > 8) return null;
      const inner = astFixedPrefixSeq(node.inner);
      if (!inner) return null;
      const seq: CharSet[] = [];
      for (let i = 0; i < node.min; i++) seq.push(...inner);
      return seq;
    }
    case "alt":
      return null;
  }
}

function unwrapSingleGroup(node: RegexAstNode): RegexAstNode {
  let cur = node;
  while (true) {
    if (cur.kind === "group" && !cur.zeroWidth) {
      cur = cur.body;
    } else if (cur.kind === "quant" && cur.min === 1 && cur.max === 1) {
      cur = cur.inner;
    } else if (cur.kind === "alt" && cur.branches.length === 1) {
      cur = cur.branches[0]!;
    } else if (cur.kind === "concat") {
      const nonZero = cur.parts.filter(
        (p) => !(p.kind === "atom" && p.zeroWidth) && !(p.kind === "group" && p.zeroWidth)
      );
      if (nonZero.length === 1) {
        cur = nonZero[0]!;
      } else {
        break;
      }
    } else {
      break;
    }
  }
  return cur;
}

function flattenConsumingParts(node: RegexAstNode): RegexAstNode[] {
  if (node.kind === "atom") {
    return node.zeroWidth ? [] : [node];
  }
  if (node.kind === "group") {
    return node.zeroWidth ? [] : flattenConsumingParts(node.body);
  }
  if (node.kind === "concat") {
    const out: RegexAstNode[] = [];
    for (const p of node.parts) {
      out.push(...flattenConsumingParts(p));
    }
    return out;
  }
  if (node.kind === "alt") {
    if (node.branches.length === 1) {
      return flattenConsumingParts(node.branches[0]!);
    }
    return [node];
  }
  if (node.kind === "quant") {
    if (node.max === 0) return [];
    if (node.min === 1 && node.max === 1) {
      return flattenConsumingParts(node.inner);
    }
    return [node];
  }
  return [node];
}

function hasMandatoryDisjointDelimiter(branch: RegexAstNode): boolean {
  const consuming = flattenConsumingParts(branch);
  if (consuming.length < 2) {
    return false;
  }
  const boundaryIndices = [0, consuming.length - 1];
  for (const idx of boundaryIndices) {
    const p = consuming[idx]!;
    if (p.kind !== "atom" || p.zeroWidth || p.isBackref) continue;
    let disjointFromAllOthers = true;
    for (let j = 0; j < consuming.length; j++) {
      if (j === idx) continue;
      if (charSetsOverlap(p.cs, astAllChars(consuming[j]!))) {
        disjointFromAllOthers = false;
        break;
      }
    }
    if (disjointFromAllOthers) {
      return true;
    }
  }
  return false;
}

function astTrailingVarQuantChars(node: RegexAstNode): CharSet {
  switch (node.kind) {
    case "atom":
      return emptyCharSet();
    case "group":
      return node.zeroWidth ? emptyCharSet() : astTrailingVarQuantChars(node.body);
    case "alt":
      return node.branches.reduce(
        (acc, b) => unionCharSet(acc, astTrailingVarQuantChars(b)),
        emptyCharSet()
      );
    case "quant":
      if (node.max === 0) return emptyCharSet();
      if (isVariableQuant(node)) return astLastChars(node);
      return astTrailingVarQuantChars(node.inner);
    case "concat": {
      let cs = emptyCharSet();
      for (let i = node.parts.length - 1; i >= 0; i--) {
        const p = node.parts[i]!;
        cs = unionCharSet(cs, astTrailingVarQuantChars(p));
        if (astMinLen(p) > 0) break;
      }
      return cs;
    }
  }
}

function astLeadingVarQuantChars(node: RegexAstNode): CharSet {
  switch (node.kind) {
    case "atom":
      return emptyCharSet();
    case "group":
      return node.zeroWidth ? emptyCharSet() : astLeadingVarQuantChars(node.body);
    case "alt":
      return node.branches.reduce(
        (acc, b) => unionCharSet(acc, astLeadingVarQuantChars(b)),
        emptyCharSet()
      );
    case "quant":
      if (node.max === 0) return emptyCharSet();
      if (isVariableQuant(node)) return astFirstChars(node);
      return astLeadingVarQuantChars(node.inner);
    case "concat": {
      let cs = emptyCharSet();
      for (const p of node.parts) {
        cs = unionCharSet(cs, astLeadingVarQuantChars(p));
        if (astMinLen(p) > 0) break;
      }
      return cs;
    }
  }
}

function dedupCharSets(sets: CharSet[]): CharSet[] {
  const seen = new Set<string>();
  const out: CharSet[] = [];
  for (const cs of sets) {
    const key = `${cs.w0}|${cs.w1}|${cs.w2}|${cs.w3}|${cs.nonAscii ? 1 : 0}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(cs);
    }
  }
  return out;
}

function branchesOverlap(branches: RegexAstNode[]): boolean {
  for (let i = 0; i < branches.length; i++) {
    for (let j = i + 1; j < branches.length; j++) {
      const b1 = branches[i]!;
      const b2 = branches[j]!;
      const s1 = astFixedPrefixSeq(b1);
      const s2 = astFixedPrefixSeq(b2);
      if (s1 && s2) {
        const minL = Math.min(s1.length, s2.length);
        let allOverlap = true;
        for (let k = 0; k < minL; k++) {
          if (!charSetsOverlap(s1[k]!, s2[k]!)) {
            allOverlap = false;
            break;
          }
        }
        if (allOverlap) return true;
      } else if (charSetsOverlap(astFirstChars(b1), astFirstChars(b2))) {
        return true;
      }
    }
  }
  return false;
}

function walkLoopBranch(
  node: RegexAstNode,
  active: CharSet[]
): { ambiguous: boolean; active: CharSet[] } {
  switch (node.kind) {
    case "atom": {
      if (node.zeroWidth) return { ambiguous: false, active };
      return {
        ambiguous: false,
        active: active.filter((cs) => charSetsOverlap(cs, node.cs))
      };
    }
    case "group":
      return node.zeroWidth
        ? { ambiguous: false, active }
        : walkLoopBranch(node.body, active);
    case "concat": {
      let cur = active;
      for (const p of node.parts) {
        const res = walkLoopBranch(p, cur);
        if (res.ambiguous) return res;
        cur = res.active;
      }
      return { ambiguous: false, active: cur };
    }
    case "alt": {
      if (node.branches.length > 1 && branchesOverlap(node.branches)) {
        return { ambiguous: true, active };
      }
      const merged: CharSet[] = [];
      for (const b of node.branches) {
        const res = walkLoopBranch(b, active);
        if (res.ambiguous) return res;
        merged.push(...res.active);
      }
      return { ambiguous: false, active: dedupCharSets(merged) };
    }
    case "quant": {
      if (node.max === 0) return { ambiguous: false, active };
      if (node.min === 1 && node.max === 1) {
        return walkLoopBranch(node.inner, active);
      }
      const innerUnwrapped = unwrapSingleGroup(node.inner);
      if (innerUnwrapped.kind === "atom") {
        if (isVariableQuant(node)) {
          if (active.some((cs) => charSetsOverlap(cs, innerUnwrapped.cs))) {
            return { ambiguous: true, active };
          }
          return {
            ambiguous: false,
            active: dedupCharSets([...active, innerUnwrapped.cs])
          };
        }
        return {
          ambiguous: false,
          active: active.filter((cs) => charSetsOverlap(cs, innerUnwrapped.cs))
        };
      }
      if (isVariableQuant(node) && active.some((cs) => charSetsOverlap(cs, astFirstChars(node)))) {
        return { ambiguous: true, active };
      }
      const innerRes = walkLoopBranch(innerUnwrapped, active);
      if (innerRes.ambiguous) return innerRes;
      const merged = [...innerRes.active];
      if (node.min === 0) merged.push(...active);
      if (isVariableQuant(node)) merged.push(astLastChars(node));
      return { ambiguous: false, active: dedupCharSets(merged) };
    }
  }
}

function hasInternalLoopAmbiguity(branch: RegexAstNode): boolean {
  return walkLoopBranch(branch, []).ambiguous;
}

const MAX_VAR_QUANT_CHOICES = 1_000_000;

function capQuantChoices(n: number): number {
  if (!Number.isFinite(n) || n > MAX_VAR_QUANT_CHOICES) {
    return MAX_VAR_QUANT_CHOICES;
  }
  return Math.max(1, n);
}

interface VarQuantMetrics {
  count: number;
  choices: number;
}

function astVarQuantMetrics(node: RegexAstNode): VarQuantMetrics {
  switch (node.kind) {
    case "atom":
      return { count: 0, choices: 1 };
    case "group":
      return node.zeroWidth ? { count: 0, choices: 1 } : astVarQuantMetrics(node.body);
    case "alt": {
      if (node.branches.length === 0) {
        return { count: 0, choices: 1 };
      }
      let maxCount = 0;
      let sumChoices = 0;
      for (const b of node.branches) {
        const m = astVarQuantMetrics(b);
        if (m.count > maxCount) maxCount = m.count;
        sumChoices += m.choices;
      }
      const isBranchingChoice =
        node.branches.length > 1 &&
        (astMinLen(node) === 0 || maxCount > 0 || branchesOverlap(node.branches));
      return {
        count: isBranchingChoice ? Math.max(1, maxCount) : maxCount,
        choices: capQuantChoices(sumChoices)
      };
    }
    case "quant": {
      if (node.max === 0) {
        return { count: 0, choices: 1 };
      }
      if (node.min === 1 && node.max === 1) {
        return astVarQuantMetrics(node.inner);
      }
      const inner = astVarQuantMetrics(node.inner);
      if (!isVariableQuant(node)) {
        if (inner.count === 0) {
          return { count: 0, choices: 1 };
        }
        const unwrapped = unwrapSingleGroup(node.inner);
        if (hasMandatoryDisjointDelimiter(unwrapped) && !hasInternalLoopAmbiguity(unwrapped)) {
          return inner;
        }
        let powChoices = 1;
        for (let i = 0; i < node.min; i++) {
          powChoices = capQuantChoices(powChoices * inner.choices);
          if (powChoices >= MAX_VAR_QUANT_CHOICES) break;
        }
        return {
          count: capQuantChoices(inner.count * node.min),
          choices: powChoices
        };
      }
      if (node.min === 0 && node.max === 1) {
        return {
          count: inner.count > 0 ? inner.count : 1,
          choices: capQuantChoices(1 + inner.choices)
        };
      }
      if (!Number.isFinite(node.max)) {
        return {
          count: Math.max(1, inner.count),
          choices: inner.count > 0 ? capQuantChoices(1 + inner.choices) : 2
        };
      }
      if (inner.count === 0) {
        return {
          count: 1,
          choices: capQuantChoices(node.max - node.min + 1)
        };
      }
      const unwrapped = unwrapSingleGroup(node.inner);
      if (hasMandatoryDisjointDelimiter(unwrapped) && !hasInternalLoopAmbiguity(unwrapped)) {
        return {
          count: inner.count,
          choices: capQuantChoices(inner.choices * (node.max - node.min + 1))
        };
      }
      let totalChoices = 0;
      let curPow = 1;
      for (let k = 0; k <= node.max; k++) {
        if (k >= node.min) {
          totalChoices = capQuantChoices(totalChoices + curPow);
          if (totalChoices >= MAX_VAR_QUANT_CHOICES) break;
        }
        curPow = capQuantChoices(curPow * inner.choices);
      }
      return {
        count: capQuantChoices(inner.count * Math.max(1, node.max)),
        choices: totalChoices
      };
    }
    case "concat": {
      const consuming = flattenConsumingParts(node);
      let active: Array<{ allChars: CharSet; count: number; choices: number }> = [];
      let maxCount = 0;
      let maxChoices = 1;
      for (const p of consuming) {
        const pMetrics = astVarQuantMetrics(p);
        const isOverlappingAlt =
          p.kind === "alt" &&
          (astMinLen(p) === 0 ||
            astContainsVarQuant(p) ||
            (p.branches.length > 1 && branchesOverlap(p.branches)));
        const isFixedWithVarQuant =
          p.kind === "quant" &&
          !isVariableQuant(p) &&
          p.max >= 1 &&
          astContainsVarQuant(p) &&
          !hasMandatoryDisjointDelimiter(unwrapSingleGroup(p.inner));
        const isVarItem = isVariableQuant(p) || isOverlappingAlt || isFixedWithVarQuant;
        if (isVarItem) {
          const pAll = astAllChars(p);
          const pFirst = astFirstChars(p);
          const overlapping = active.filter((q) => charSetsOverlap(q.allChars, pFirst));
          let chainCount = pMetrics.count;
          let chainChoices = pMetrics.choices;
          for (const q of overlapping) {
            chainCount = capQuantChoices(chainCount + q.count);
            chainChoices = capQuantChoices(chainChoices * q.choices);
          }
          if (chainCount > maxCount) maxCount = chainCount;
          if (chainChoices > maxChoices) maxChoices = chainChoices;
          if (astMinLen(p) > 0) {
            active = active.filter((q) => charSetsOverlap(q.allChars, pAll));
          }
          active.push({ allChars: pAll, count: pMetrics.count, choices: pMetrics.choices });
        } else {
          if (pMetrics.count > maxCount) maxCount = pMetrics.count;
          if (pMetrics.choices > maxChoices) maxChoices = pMetrics.choices;
          if (astMinLen(p) > 0) {
            const pAll = astAllChars(p);
            active = active.filter((q) => charSetsOverlap(q.allChars, pAll));
          }
        }
      }
      return { count: maxCount, choices: maxChoices };
    }
  }
}

function isStartAnchored(node: RegexAstNode): boolean {
  switch (node.kind) {
    case "atom":
      return Boolean(node.isStartAnchor);
    case "group":
      return !node.zeroWidth && isStartAnchored(node.body);
    case "alt":
      return node.branches.length > 0 && node.branches.every(isStartAnchored);
    case "quant":
      return node.min >= 1 && isStartAnchored(node.inner);
    case "concat": {
      for (const p of node.parts) {
        if (isStartAnchored(p)) {
          return true;
        }
        if ((p.kind === "atom" && p.zeroWidth) || (p.kind === "group" && p.zeroWidth)) {
          continue;
        }
        return false;
      }
      return false;
    }
  }
}

function assertSafeRegexNode(node: RegexAstNode, path: string, startAnchored: boolean): void {
  switch (node.kind) {
    case "atom":
      return;
    case "group":
      assertSafeRegexNode(node.body, path, startAnchored);
      return;
    case "alt":
      for (const b of node.branches) {
        assertSafeRegexNode(b, path, startAnchored || isStartAnchored(b));
      }
      return;
    case "concat": {
      let curAnchored = startAnchored;
      for (const p of node.parts) {
        assertSafeRegexNode(p, path, curAnchored || isStartAnchored(p));
        if (curAnchored && astFixedPrefixSeq(p) === null) {
          curAnchored = false;
        }
      }
      const consuming = flattenConsumingParts(node);
      for (let i = 0; i < consuming.length - 1; i++) {
        const a = consuming[i]!;
        const aIsUnboundedOrLargeQuant =
          a.kind === "quant" &&
          (a.max === Infinity || (a.max > a.min && a.max >= 4) || astContainsUnboundedQuant(a));
        const aIsUnboundedAlt = a.kind === "alt" && astContainsUnboundedQuant(a);
        if (!aIsUnboundedOrLargeQuant && !aIsUnboundedAlt) {
          continue;
        }
        const aLastChars = aIsUnboundedAlt ? astTrailingVarQuantChars(a) : astLastChars(a);
        for (let j = i + 1; j < consuming.length; j++) {
          const b = consuming[j]!;
          const bIsUnboundedOrLargeQuant =
            b.kind === "quant" &&
            (b.max === Infinity || (b.max > b.min && b.max >= 4) || astContainsUnboundedQuant(b));
          const bIsUnboundedAlt = b.kind === "alt" && astContainsUnboundedQuant(b);
          if (bIsUnboundedOrLargeQuant || bIsUnboundedAlt) {
            const bFirstChars = bIsUnboundedAlt ? astLeadingVarQuantChars(b) : astFirstChars(b);
            if (charSetsOverlap(aLastChars, bFirstChars)) {
              throw new HubError(
                400,
                "BAD_REQUEST",
                `result_schema 'pattern' at ${path} contains adjacent overlapping quantifiers (ReDoS risk).`
              );
            }
          }
          if (astMinLen(b) > 0) break;
        }
      }
      let activeUnbounded: RegexAstNode[] = [];
      const maxOverlappingUnbounded = startAnchored ? 1 : 0;
      for (const p of consuming) {
        const pUnbounded =
          (p.kind === "quant" && (p.max === Infinity || astContainsUnboundedQuant(p))) ||
          (p.kind === "alt" && astContainsUnboundedQuant(p));
        if (pUnbounded) {
          const pChars = astAllChars(p);
          const pFirst = astFirstChars(p);
          const overlapping = activeUnbounded.filter((q) =>
            charSetsOverlap(astAllChars(q), pFirst)
          );
          if (overlapping.length > maxOverlappingUnbounded) {
            throw new HubError(
              400,
              "BAD_REQUEST",
              `result_schema 'pattern' at ${path} contains excessive chained overlapping unbounded quantifiers (ReDoS risk).`
            );
          }
          if (astMinLen(p) > 0) {
            activeUnbounded = activeUnbounded.filter((q) =>
              charSetsOverlap(astAllChars(q), pChars)
            );
          }
          activeUnbounded.push(p);
        } else if (astMinLen(p) > 0) {
          const pChars = astAllChars(p);
          activeUnbounded = activeUnbounded.filter((q) =>
            charSetsOverlap(astAllChars(q), pChars)
          );
        }
      }
      interface ActiveVarQuant {
        allChars: CharSet;
        count: number;
        choices: number;
      }
      let activeVarQuants: ActiveVarQuant[] = [];
      for (const p of consuming) {
        const isOverlappingAlt =
          p.kind === "alt" &&
          (astMinLen(p) === 0 ||
            astContainsVarQuant(p) ||
            (p.branches.length > 1 && branchesOverlap(p.branches)));
        const isFixedWithVarQuant =
          p.kind === "quant" &&
          !isVariableQuant(p) &&
          p.max >= 1 &&
          astContainsVarQuant(p) &&
          !hasMandatoryDisjointDelimiter(unwrapSingleGroup(p.inner));
        const isVarItem = isVariableQuant(p) || isOverlappingAlt || isFixedWithVarQuant;
        if (isVarItem) {
          const pMetrics = astVarQuantMetrics(p);
          const pAll = astAllChars(p);
          const pFirst = astFirstChars(p);
          const overlapping = activeVarQuants.filter((q) =>
            charSetsOverlap(q.allChars, pFirst)
          );
          if (overlapping.length >= 1) {
            let chainCount = pMetrics.count;
            let boundedProduct = pMetrics.choices;
            for (const q of overlapping) {
              chainCount = capQuantChoices(chainCount + q.count);
              boundedProduct = capQuantChoices(boundedProduct * q.choices);
            }
            if (chainCount >= 4 || boundedProduct > 16) {
              throw new HubError(
                400,
                "BAD_REQUEST",
                `result_schema 'pattern' at ${path} contains excessive chained overlapping variable quantifiers (ReDoS risk).`
              );
            }
          }
          if (astMinLen(p) > 0) {
            activeVarQuants = activeVarQuants.filter((q) =>
              charSetsOverlap(q.allChars, pAll)
            );
          }
          activeVarQuants.push({
            allChars: pAll,
            count: pMetrics.count,
            choices: pMetrics.choices
          });
        } else if (astMinLen(p) > 0) {
          const pAll = astAllChars(p);
          activeVarQuants = activeVarQuants.filter((q) =>
            charSetsOverlap(q.allChars, pAll)
          );
        }
      }
      return;
    }
    case "quant": {
      assertSafeRegexNode(node.inner, path, node.max > 1 ? false : startAnchored);
      const body = unwrapSingleGroup(node.inner);
      if (node.max <= 1) {
        if (body.kind === "atom" && !body.zeroWidth && !body.isBackref) {
          return;
        }
        const metrics = astVarQuantMetrics(node);
        if (metrics.count >= 4 || (metrics.count >= 2 && metrics.choices > 16)) {
          throw new HubError(
            400,
            "BAD_REQUEST",
            `result_schema 'pattern' at ${path} contains excessive nested variable quantifiers (ReDoS risk).`
          );
        }
        return;
      }
      if (body.kind === "atom" && !body.zeroWidth && !body.isBackref) {
        return;
      }
      if (astHasBackref(body)) {
        throw new HubError(
          400,
          "BAD_REQUEST",
          `result_schema 'pattern' at ${path} contains a quantified backreference (ReDoS risk).`
        );
      }
      if (astMinLen(body) === 0) {
        throw new HubError(
          400,
          "BAD_REQUEST",
          `result_schema 'pattern' at ${path} contains a quantified empty-matching group (ReDoS risk).`
        );
      }
      const branches = body.kind === "alt" ? body.branches : [body];
      if (branches.length > 1 && branchesOverlap(branches)) {
        throw new HubError(
          400,
          "BAD_REQUEST",
          `result_schema 'pattern' at ${path} contains overlapping quantified alternation (ReDoS risk).`
        );
      }
      for (const b of branches) {
        const unwrappedBranch = unwrapSingleGroup(b);
        if (
          astContainsRepeatingOrVarQuant(unwrappedBranch) &&
          (!hasMandatoryDisjointDelimiter(unwrappedBranch) ||
            hasInternalLoopAmbiguity(unwrappedBranch))
        ) {
          throw new HubError(
            400,
            "BAD_REQUEST",
            `result_schema 'pattern' at ${path} contains nested quantifiers (ReDoS risk).`
          );
        }
      }
      for (let i = 0; i < branches.length; i++) {
        const b1 = unwrapSingleGroup(branches[i]!);
        const b1TrailVar = astTrailingVarQuantChars(b1);
        const b1Last = astLastChars(b1);
        for (let j = 0; j < branches.length; j++) {
          const b2 = unwrapSingleGroup(branches[j]!);
          if (
            charSetsOverlap(b1TrailVar, astFirstChars(b2)) ||
            charSetsOverlap(b1Last, astLeadingVarQuantChars(b2))
          ) {
            throw new HubError(
              400,
              "BAD_REQUEST",
              `result_schema 'pattern' at ${path} contains loop wrap-around overlapping quantifiers (ReDoS risk).`
            );
          }
        }
      }
      return;
    }
  }
}

export function assertSafeRegexPattern(pattern: string, path = "$"): void {
  const ast = parseRegexAst(pattern);
  assertSafeRegexNode(ast, path, isStartAnchored(ast));
}

function validateSchemaNode(
  node: unknown,
  depth: number,
  state: SchemaWalkState,
  path: string
): void {
  if (!isPlainJsonObject(node)) {
    throw new HubError(400, "BAD_REQUEST", `result_schema node at ${path} must be a plain JSON object.`);
  }
  if (state.visiting.has(node)) {
    throw new HubError(400, "BAD_REQUEST", `result_schema contains a circular reference at ${path}.`);
  }
  if (depth > MAX_RESULT_SCHEMA_DEPTH) {
    throw new HubError(
      400,
      "BAD_REQUEST",
      `result_schema exceeds max nesting depth of ${MAX_RESULT_SCHEMA_DEPTH} at ${path}.`
    );
  }
  state.nodeCount += 1;
  if (state.nodeCount > MAX_RESULT_SCHEMA_NODES) {
    throw new HubError(
      400,
      "BAD_REQUEST",
      `result_schema exceeds max node count of ${MAX_RESULT_SCHEMA_NODES}.`
    );
  }

  state.visiting.add(node);
  try {
    for (const [key, val] of Object.entries(node)) {
      if (!ALLOWED_SCHEMA_KEYWORDS.has(key)) {
        throw new HubError(
          400,
          "BAD_REQUEST",
          `Unsupported or forbidden JSON Schema keyword '${key}' at ${path}.`
        );
      }

      switch (key) {
        case "$schema":
        case "$id":
        case "title":
        case "description":
        case "$comment": {
          if (typeof val !== "string") {
            throw new HubError(
              400,
              "BAD_REQUEST",
              `result_schema keyword '${key}' at ${path} must be a string.`
            );
          }
          break;
        }
        case "examples": {
          if (!Array.isArray(val)) {
            throw new HubError(
              400,
              "BAD_REQUEST",
              `result_schema keyword 'examples' at ${path} must be an array.`
            );
          }
          break;
        }
        case "default": {
          if (val === undefined) {
            throw new HubError(
              400,
              "BAD_REQUEST",
              `result_schema keyword 'default' at ${path} must be defined.`
            );
          }
          break;
        }
        case "const": {
          if (val === undefined) {
            throw new HubError(
              400,
              "BAD_REQUEST",
              `result_schema keyword 'const' at ${path} must be defined.`
            );
          }
          break;
        }
        case "type": {
          if (typeof val === "string") {
            if (!SCHEMA_TYPES.has(val)) {
              throw new HubError(
                400,
                "BAD_REQUEST",
                `Invalid result_schema type '${val}' at ${path}.`
              );
            }
          } else if (Array.isArray(val)) {
            if (val.length === 0) {
              throw new HubError(
                400,
                "BAD_REQUEST",
                `result_schema 'type' array at ${path} must not be empty.`
              );
            }
            const seen = new Set<string>();
            for (const item of val) {
              if (typeof item !== "string" || !SCHEMA_TYPES.has(item)) {
                throw new HubError(
                  400,
                  "BAD_REQUEST",
                  `Invalid type element in result_schema 'type' array at ${path}.`
                );
              }
              if (seen.has(item)) {
                throw new HubError(
                  400,
                  "BAD_REQUEST",
                  `Duplicate type '${item}' in result_schema 'type' array at ${path}.`
                );
              }
              seen.add(item);
            }
          } else {
            throw new HubError(
              400,
              "BAD_REQUEST",
              `result_schema keyword 'type' at ${path} must be a string or non-empty array.`
            );
          }
          break;
        }
        case "enum": {
          if (!Array.isArray(val) || val.length === 0 || val.some((item) => item === undefined)) {
            throw new HubError(
              400,
              "BAD_REQUEST",
              `result_schema keyword 'enum' at ${path} must be a non-empty array.`
            );
          }
          break;
        }
        case "properties": {
          if (!isPlainJsonObject(val)) {
            throw new HubError(
              400,
              "BAD_REQUEST",
              `result_schema keyword 'properties' at ${path} must be a plain JSON object.`
            );
          }
          for (const [propName, propSchema] of Object.entries(val)) {
            validateSchemaNode(propSchema, depth + 1, state, `${path}.properties.${propName}`);
          }
          break;
        }
        case "required": {
          if (!Array.isArray(val)) {
            throw new HubError(
              400,
              "BAD_REQUEST",
              `result_schema keyword 'required' at ${path} must be an array.`
            );
          }
          const seen = new Set<string>();
          for (const item of val) {
            if (typeof item !== "string") {
              throw new HubError(
                400,
                "BAD_REQUEST",
                `result_schema 'required' items at ${path} must be strings.`
              );
            }
            if (seen.has(item)) {
              throw new HubError(
                400,
                "BAD_REQUEST",
                `Duplicate property '${item}' in result_schema 'required' at ${path}.`
              );
            }
            seen.add(item);
          }
          break;
        }
        case "additionalProperties": {
          if (typeof val !== "boolean") {
            validateSchemaNode(val, depth + 1, state, `${path}.additionalProperties`);
          }
          break;
        }
        case "minProperties":
        case "maxProperties":
        case "minItems":
        case "maxItems":
        case "minLength":
        case "maxLength": {
          assertNonNegativeInt(val, key, path);
          break;
        }
        case "items": {
          validateSchemaNode(val, depth + 1, state, `${path}.items`);
          break;
        }
        case "uniqueItems": {
          if (typeof val !== "boolean") {
            throw new HubError(
              400,
              "BAD_REQUEST",
              `result_schema keyword 'uniqueItems' at ${path} must be a boolean.`
            );
          }
          break;
        }
        case "pattern": {
          if (typeof val !== "string") {
            throw new HubError(
              400,
              "BAD_REQUEST",
              `result_schema keyword 'pattern' at ${path} must be a string.`
            );
          }
          if (codePointLength(val) > MAX_RESULT_SCHEMA_PATTERN_LENGTH) {
            throw new HubError(
              400,
              "BAD_REQUEST",
              `result_schema 'pattern' at ${path} exceeds max length ${MAX_RESULT_SCHEMA_PATTERN_LENGTH}.`
            );
          }
          try {
            new RegExp(val, "u");
          } catch {
            throw new HubError(
              400,
              "BAD_REQUEST",
              `Invalid RegExp in result_schema 'pattern' at ${path}.`
            );
          }
          assertSafeRegexPattern(val, path);
          break;
        }
        case "format": {
          if (typeof val !== "string" || !ALLOWED_FORMATS.has(val)) {
            throw new HubError(
              400,
              "BAD_REQUEST",
              `Unsupported result_schema 'format' at ${path} (allowed: date-time, date, email, uri, uuid).`
            );
          }
          break;
        }
        case "minimum":
        case "maximum":
        case "exclusiveMinimum":
        case "exclusiveMaximum": {
          assertFiniteNumber(val, key, path);
          break;
        }
        case "multipleOf": {
          assertFiniteNumber(val, key, path);
          if ((val as number) <= 0) {
            throw new HubError(
              400,
              "BAD_REQUEST",
              `result_schema keyword 'multipleOf' at ${path} must be > 0.`
            );
          }
          break;
        }
        case "allOf":
        case "anyOf":
        case "oneOf": {
          if (!Array.isArray(val) || val.length === 0) {
            throw new HubError(
              400,
              "BAD_REQUEST",
              `result_schema keyword '${key}' at ${path} must be a non-empty array.`
            );
          }
          for (let i = 0; i < val.length; i++) {
            validateSchemaNode(val[i], depth + 1, state, `${path}.${key}[${i}]`);
          }
          break;
        }
      }
    }
  } finally {
    state.visiting.delete(node);
  }
}

export function validateResultSchemaDefinition(raw: unknown): Record<string, unknown> {
  if (!isPlainJsonObject(raw)) {
    throw new HubError(400, "BAD_REQUEST", "result_schema must be a plain JSON object.");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    throw new HubError(400, "BAD_REQUEST", "result_schema must be JSON-serializable.");
  }
  if (typeof serialized !== "string") {
    throw new HubError(400, "BAD_REQUEST", "result_schema must be JSON-serializable.");
  }
  const bytes = utf8Encoder.encode(serialized).length;
  if (bytes > MAX_RESULT_SCHEMA_BYTES) {
    throw new HubError(
      400,
      "BAD_REQUEST",
      `result_schema exceeds max serialized size of ${MAX_RESULT_SCHEMA_BYTES} UTF-8 bytes.`
    );
  }
  validateSchemaNode(raw, 0, { nodeCount: 0, visiting: new WeakSet() }, "$");
  return raw;
}

export function deepEqualJson(a: unknown, b: unknown): boolean {
  const stack: Array<[unknown, unknown]> = [[a, b]];
  while (stack.length > 0) {
    const [left, right] = stack.pop()!;
    if (Object.is(left, right)) {
      continue;
    }
    if (typeof left === "number" && typeof right === "number" && left === right) {
      continue;
    }
    if (
      left === null ||
      right === null ||
      typeof left !== "object" ||
      typeof right !== "object"
    ) {
      return false;
    }
    const leftIsArr = Array.isArray(left);
    if (leftIsArr !== Array.isArray(right)) {
      return false;
    }
    if (leftIsArr) {
      const rightArr = right as unknown[];
      if (left.length !== rightArr.length) {
        return false;
      }
      for (let i = left.length - 1; i >= 0; i--) {
        stack.push([left[i], rightArr[i]]);
      }
      continue;
    }

    const leftObj = left as Record<string, unknown>;
    const rightObj = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftObj);
    const rightKeys = Object.keys(rightObj);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    for (const k of leftKeys) {
      if (!hasOwn(rightObj, k)) {
        return false;
      }
      stack.push([leftObj[k], rightObj[k]]);
    }
  }
  return true;
}

function canonicalizeJson(root: unknown): string {
  type Frame =
    | { kind: "value"; val: unknown }
    | { kind: "literal"; text: string }
    | { kind: "join_array"; count: number }
    | { kind: "join_object"; keys: string[] };

  const stack: Frame[] = [{ kind: "value", val: root }];
  const out: string[] = [];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "literal") {
      out.push(frame.text);
      continue;
    }
    if (frame.kind === "join_array") {
      const items = out.splice(out.length - frame.count, frame.count);
      out.push(`[${items.join(",")}]`);
      continue;
    }
    if (frame.kind === "join_object") {
      const count = frame.keys.length;
      const vals = out.splice(out.length - count, count);
      const parts: string[] = [];
      for (let i = 0; i < count; i++) {
        parts.push(`${JSON.stringify(frame.keys[i]!)}:${vals[i]!}`);
      }
      out.push(`{${parts.join(",")}}`);
      continue;
    }

    const val = frame.val;
    if (val === null) {
      out.push("null");
    } else if (typeof val === "boolean") {
      out.push(val ? "b:1" : "b:0");
    } else if (typeof val === "number") {
      out.push(`n:${val === 0 ? 0 : val}`);
    } else if (typeof val === "string") {
      out.push(`s:${JSON.stringify(val)}`);
    } else if (Array.isArray(val)) {
      stack.push({ kind: "join_array", count: val.length });
      for (let i = val.length - 1; i >= 0; i--) {
        stack.push({ kind: "value", val: val[i] });
      }
    } else if (typeof val === "object") {
      const obj = val as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      stack.push({ kind: "join_object", keys });
      for (let i = keys.length - 1; i >= 0; i--) {
        stack.push({ kind: "value", val: obj[keys[i]!] });
      }
    } else {
      out.push(`u:${String(val)}`);
    }
  }

  return out[0] ?? "";
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDay =
    month === 2 ? (isLeap ? 29 : 28) : month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
  return day <= maxDay;
}

function matchesFormat(format: string, value: string): boolean {
  switch (format) {
    case "uuid":
      return UUID_RE.test(value);
    case "date": {
      const m = DATE_RE.exec(value);
      if (!m) return false;
      return isValidCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
    }
    case "date-time": {
      const m = DATE_TIME_RE.exec(value);
      if (!m) return false;
      const year = Number(m[1]);
      const month = Number(m[2]);
      const day = Number(m[3]);
      const hour = Number(m[4]);
      const minute = Number(m[5]);
      const second = Number(m[6]);
      if (!isValidCalendarDate(year, month, day)) return false;
      if (hour > 23 || minute > 59 || second > 60) return false;
      if (m[8] !== undefined && m[9] !== undefined) {
        const tzHour = Number(m[8]);
        const tzMin = Number(m[9]);
        if (tzHour > 23 || tzMin > 59) return false;
      }
      return true;
    }
    case "email": {
      if (value.length === 0 || value.length > 320 || /[\s\u0000-\u001f\u007f]/.test(value)) {
        return false;
      }
      const atIdx = value.indexOf("@");
      if (atIdx <= 0 || atIdx !== value.lastIndexOf("@")) {
        return false;
      }
      const local = value.slice(0, atIdx);
      const domain = value.slice(atIdx + 1);
      if (local.length > 64 || domain.length === 0 || domain.length > 253) {
        return false;
      }
      if (
        local.startsWith(".") ||
        local.endsWith(".") ||
        local.includes("..") ||
        !EMAIL_LOCAL_RE.test(local)
      ) {
        return false;
      }
      const labels = domain.split(".");
      if (labels.length < 2) {
        return false;
      }
      return labels.every((lbl) => DNS_LABEL_RE.test(lbl));
    }
    case "uri": {
      if (value.length === 0 || /[\s\u0000-\u001f\u007f]/.test(value)) {
        return false;
      }
      if (!URI_SCHEME_RE.test(value)) {
        return false;
      }
      try {
        const parsed = new URL(value);
        const afterScheme = value.slice(parsed.protocol.length);
        if (
          afterScheme.startsWith("//") &&
          parsed.protocol !== "file:" &&
          parsed.host.length === 0
        ) {
          return false;
        }
        return true;
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

function parseDecimalNumber(num: number): { digits: bigint; scale: number } | null {
  const m = DECIMAL_NUM_RE.exec(num.toString());
  if (!m) return null;
  const intPart = m[2]!;
  const fracPart = m[3] ?? "";
  const exp = m[4] ? Number.parseInt(m[4], 10) : 0;
  const combined = `${intPart}${fracPart}`.replace(/^0+/, "") || "0";
  return {
    digits: BigInt(combined),
    scale: fracPart.length - exp
  };
}

function isMultipleOf(value: number, divisor: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(divisor) || divisor <= 0) {
    return false;
  }
  if (value === 0) {
    return true;
  }
  const a = parseDecimalNumber(value);
  const b = parseDecimalNumber(divisor);
  if (a && b) {
    if (b.digits === 0n) return false;
    const commonScale = Math.max(a.scale, b.scale);
    const aShift = commonScale - a.scale;
    const bShift = commonScale - b.scale;
    if (aShift <= 350 && bShift <= 350) {
      const aScaled = a.digits * 10n ** BigInt(aShift);
      const bScaled = b.digits * 10n ** BigInt(bShift);
      return aScaled % bScaled === 0n;
    }
  }
  const ratio = value / divisor;
  if (!Number.isFinite(ratio)) return false;
  return Math.abs(ratio - Math.round(ratio)) <= 1e-12 * Math.max(1, Math.abs(ratio));
}

function matchesSchemaType(typeName: string, value: unknown): boolean {
  switch (typeName) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainJsonObject(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    default:
      return false;
  }
}

function describeJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function validateNodeAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  errors: string[]
): void {
  if (errors.length >= MAX_VALIDATION_ERRORS) {
    return;
  }

  const pushError = (msg: string): void => {
    if (errors.length < MAX_VALIDATION_ERRORS) {
      errors.push(msg);
    }
  };

  if (hasOwn(schema, "type")) {
    const rawType = schema["type"];
    const allowed = Array.isArray(rawType) ? (rawType as string[]) : [rawType as string];
    if (!allowed.some((t) => matchesSchemaType(t, value))) {
      pushError(`${path}: expected type ${allowed.join("|")}, got ${describeJsonType(value)}`);
    }
  }

  if (hasOwn(schema, "const")) {
    if (!deepEqualJson(value, schema["const"])) {
      pushError(`${path}: value does not match const`);
    }
  }

  if (hasOwn(schema, "enum")) {
    const enumVals = schema["enum"] as unknown[];
    if (!enumVals.some((item) => deepEqualJson(value, item))) {
      pushError(`${path}: value is not in enum`);
    }
  }

  if (isPlainJsonObject(value)) {
    const keys = Object.keys(value);
    if (typeof schema["minProperties"] === "number" && keys.length < schema["minProperties"]) {
      pushError(`${path}: object has ${keys.length} properties, expected >= ${schema["minProperties"]}`);
    }
    if (typeof schema["maxProperties"] === "number" && keys.length > schema["maxProperties"]) {
      pushError(`${path}: object has ${keys.length} properties, expected <= ${schema["maxProperties"]}`);
    }
    if (Array.isArray(schema["required"])) {
      for (const reqKey of schema["required"] as string[]) {
        if (!hasOwn(value, reqKey)) {
          pushError(`${path}: missing required property '${reqKey}'`);
        }
      }
    }
    const props = isPlainJsonObject(schema["properties"]) ? schema["properties"] : undefined;
    if (props) {
      for (const [propKey, propSchema] of Object.entries(props)) {
        if (hasOwn(value, propKey) && isPlainJsonObject(propSchema)) {
          validateNodeAgainstSchema(propSchema, value[propKey], `${path}.${propKey}`, errors);
        }
      }
    }
    if (hasOwn(schema, "additionalProperties")) {
      const addl = schema["additionalProperties"];
      for (const key of keys) {
        if (props && hasOwn(props, key)) {
          continue;
        }
        if (addl === false) {
          pushError(`${path}: unexpected additional property '${key}'`);
        } else if (isPlainJsonObject(addl)) {
          validateNodeAgainstSchema(addl, value[key], `${path}.${key}`, errors);
        }
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) {
      pushError(`${path}: array has ${value.length} items, expected >= ${schema["minItems"]}`);
    }
    if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"]) {
      pushError(`${path}: array has ${value.length} items, expected <= ${schema["maxItems"]}`);
    }
    if (schema["uniqueItems"] === true) {
      const seen = new Set<string>();
      for (let i = 0; i < value.length; i++) {
        const key = canonicalizeJson(value[i]);
        if (seen.has(key)) {
          pushError(`${path}: array items must be unique (duplicate at index ${i})`);
          break;
        }
        seen.add(key);
      }
    }
    if (isPlainJsonObject(schema["items"])) {
      for (let i = 0; i < value.length; i++) {
        validateNodeAgainstSchema(schema["items"], value[i], `${path}[${i}]`, errors);
        if (errors.length >= MAX_VALIDATION_ERRORS) {
          break;
        }
      }
    }
  }

  if (typeof value === "string") {
    const hasMin = typeof schema["minLength"] === "number";
    const hasMax = typeof schema["maxLength"] === "number";
    if (hasMin || hasMax) {
      const len = codePointLength(value);
      if (hasMin && len < (schema["minLength"] as number)) {
        pushError(`${path}: string length ${len} < minLength ${schema["minLength"]}`);
      }
      if (hasMax && len > (schema["maxLength"] as number)) {
        pushError(`${path}: string length ${len} > maxLength ${schema["maxLength"]}`);
      }
    }
    if (typeof schema["pattern"] === "string") {
      const re = new RegExp(schema["pattern"], "u");
      if (!re.test(value)) {
        pushError(`${path}: string does not match pattern`);
      }
    }
    if (typeof schema["format"] === "string") {
      if (!matchesFormat(schema["format"], value)) {
        pushError(`${path}: string does not match format '${schema["format"]}'`);
      }
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) {
      pushError(`${path}: ${value} < minimum ${schema["minimum"]}`);
    }
    if (typeof schema["maximum"] === "number" && value > schema["maximum"]) {
      pushError(`${path}: ${value} > maximum ${schema["maximum"]}`);
    }
    if (typeof schema["exclusiveMinimum"] === "number" && value <= schema["exclusiveMinimum"]) {
      pushError(`${path}: ${value} <= exclusiveMinimum ${schema["exclusiveMinimum"]}`);
    }
    if (typeof schema["exclusiveMaximum"] === "number" && value >= schema["exclusiveMaximum"]) {
      pushError(`${path}: ${value} >= exclusiveMaximum ${schema["exclusiveMaximum"]}`);
    }
    if (typeof schema["multipleOf"] === "number" && !isMultipleOf(value, schema["multipleOf"])) {
      pushError(`${path}: ${value} is not a multipleOf ${schema["multipleOf"]}`);
    }
  }

  if (Array.isArray(schema["allOf"])) {
    for (const sub of schema["allOf"] as Record<string, unknown>[]) {
      validateNodeAgainstSchema(sub, value, path, errors);
    }
  }

  if (Array.isArray(schema["anyOf"])) {
    const subs = schema["anyOf"] as Record<string, unknown>[];
    let matched = false;
    for (const sub of subs) {
      const subErrors: string[] = [];
      validateNodeAgainstSchema(sub, value, path, subErrors);
      if (subErrors.length === 0) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      pushError(`${path}: value failed all schemas in anyOf`);
    }
  }

  if (Array.isArray(schema["oneOf"])) {
    const subs = schema["oneOf"] as Record<string, unknown>[];
    let matchCount = 0;
    for (const sub of subs) {
      const subErrors: string[] = [];
      validateNodeAgainstSchema(sub, value, path, subErrors);
      if (subErrors.length === 0) {
        matchCount += 1;
      }
    }
    if (matchCount !== 1) {
      pushError(`${path}: value matched ${matchCount} schemas in oneOf (expected 1)`);
    }
  }
}

export function validateValueAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  validateNodeAgainstSchema(schema, value, "$", errors);
  return { valid: errors.length === 0, errors };
}
