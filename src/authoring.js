import { sRgbToOklchBuffer, displayP3ToOklchBuffer } from './convert.js';
import { packOklchBufferToUint32 } from './runtime.js';

const RAD_TO_DEG = 180 / Math.PI;

// ============================================================================
// 1. UTILITIES
// ============================================================================

/**
 * Parses a CSS numeric token. `'50%'` -> `0.5 * max`. `'50'` -> `50`. `''` / undefined -> undefined.
 * @internal
 */
const parseVal = (val, max = 1) => {
    if (val === undefined || val === null || val === '') return undefined;
    return val.endsWith('%') ? (parseFloat(val) / 100) * max : parseFloat(val);
};

/**
 * Parses a CSS hue token, accepting `deg` (default), `rad`, and `turn` units.
 * Result is canonicalized to [0, 360).
 * @internal
 */
const parseHue = (val) => {
    let h = parseFloat(val);
    if (val.includes('rad')) h *= RAD_TO_DEG;
    if (val.includes('turn')) h *= 360;
    const m = h % 360;
    return m < 0 ? m + 360 : m;
};

/**
 * Reference HSL -> sRGB conversion. Used as a stepping stone before sRGB -> OKLCH.
 * @internal
 */
const hslToRgb = (h, s, l) => {
    h /= 360;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return [
        (hue2rgb(p, q, h + 1 / 3) * 255 + 0.5) | 0,
        (hue2rgb(p, q, h) * 255 + 0.5) | 0,
        (hue2rgb(p, q, h - 1 / 3) * 255 + 0.5) | 0
    ];
};

// (linearize lives in convert.js; the parsers below delegate color-space math there)

// ============================================================================
// 2. REGEX DICTIONARY (CSS Color Level 4 Permissive)
// ============================================================================

const HEX_REGEX = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})?$/i;
const SHORT_HEX_REGEX = /^#([a-f\d])([a-f\d])([a-f\d])([a-f\d])?$/i;
const OKLCH_REGEX = /^oklch\(\s*([\d.%]+)\s+([\d.%]+)\s+([\d.%a-z]+)(?:\s*\/\s*([\d.%]+))?\s*\)$/i;
const OKLAB_REGEX = /^oklab\(\s*([\d.%]+)[,\s]+([\d.-]+)[,\s]+([\d.-]+)(?:[,\s/]+([\d.%]+))?\s*\)$/i;
const RGB_REGEX = /^rgba?\(\s*([\d.%]+)[,\s]+([\d.%]+)[,\s]+([\d.%]+)(?:(?:,|\s*\/\s*)\s*([\d.%]+))?\s*\)$/i;
const HSL_REGEX = /^hsla?\(\s*([\d.%a-z]+)[,\s]+([\d.%]+)[,\s]+([\d.%]+)(?:(?:,|\s*\/\s*)\s*([\d.%]+))?\s*\)$/i;
const DISPLAY_P3_REGEX = /^color\(\s*display-p3\s+([\d.%]+)\s+([\d.%]+)\s+([\d.%]+)(?:\s*\/\s*([\d.%]+))?\s*\)$/i;

// ============================================================================
// 3. NAMED COLORS FAST-PATH
// ============================================================================

/** CSS Color Module Level 4 named-color table. Single allocation at module load. */
const NAMED_COLORS = {
    aliceblue: '#f0f8ff', antiquewhite: '#faebd7', aqua: '#00ffff', aquamarine: '#7fffd4',
    azure: '#f0ffff', beige: '#f5f5dc', bisque: '#ffe4c4', black: '#000000',
    blanchedalmond: '#ffebcd', blue: '#0000ff', blueviolet: '#8a2be2', brown: '#a52a2a',
    burlywood: '#deb887', cadetblue: '#5f9ea0', chartreuse: '#7fff00', chocolate: '#d2691e',
    coral: '#ff7f50', cornflowerblue: '#6495ed', cornsilk: '#fff8dc', crimson: '#dc143c',
    cyan: '#00ffff', darkblue: '#00008b', darkcyan: '#008b8b', darkgoldenrod: '#b8860b',
    darkgray: '#a9a9a9', darkgreen: '#006400', darkgrey: '#a9a9a9', darkkhaki: '#bdb76b',
    darkmagenta: '#8b008b', darkolivegreen: '#556b2f', darkorange: '#ff8c00', darkorchid: '#9932cc',
    darkred: '#8b0000', darksalmon: '#e9967a', darkseagreen: '#8fbc8f', darkslateblue: '#483d8b',
    darkslategray: '#2f4f4f', darkslategrey: '#2f4f4f', darkturquoise: '#00ced1', darkviolet: '#9400d3',
    deeppink: '#ff1493', deepskyblue: '#00bfff', dimgray: '#696969', dimgrey: '#696969',
    dodgerblue: '#1e90ff', firebrick: '#b22222', floralwhite: '#fffaf0', forestgreen: '#228b22',
    fuchsia: '#ff00ff', gainsboro: '#dcdcdc', ghostwhite: '#f8f8ff', gold: '#ffd700',
    goldenrod: '#daa520', gray: '#808080', green: '#008000', greenyellow: '#adff2f',
    grey: '#808080', honeydew: '#f0fff0', hotpink: '#ff69b4', indianred: '#cd5c5c',
    indigo: '#4b0082', ivory: '#fffff0', khaki: '#f0e68c', lavender: '#e6e6fa',
    lavenderblush: '#fff0f5', lawngreen: '#7cfc00', lemonchiffon: '#fffacd', lightblue: '#add8e6',
    lightcoral: '#f08080', lightcyan: '#e0ffff', lightgoldenrodyellow: '#fafad2', lightgray: '#d3d3d3',
    lightgreen: '#90ee90', lightgrey: '#d3d3d3', lightpink: '#ffb6c1', lightsalmon: '#ffa07a',
    lightseagreen: '#20b2aa', lightskyblue: '#87cefa', lightslategray: '#778899', lightslategrey: '#778899',
    lightsteelblue: '#b0c4de', lightyellow: '#ffffe0', lime: '#00ff00', limegreen: '#32cd32',
    linen: '#faf0e6', magenta: '#ff00ff', maroon: '#800000', mediumaquamarine: '#66cdaa',
    mediumblue: '#0000cd', mediumorchid: '#ba55d3', mediumpurple: '#9370db', mediumseagreen: '#3cb371',
    mediumslateblue: '#7b68ee', mediumspringgreen: '#00fa9a', mediumturquoise: '#48d1cc', mediumvioletred: '#c71585',
    midnightblue: '#191970', mintcream: '#f5fffa', mistyrose: '#ffe4e1', moccasin: '#ffe4b5',
    navajowhite: '#ffdead', navy: '#000080', oldlace: '#fdf5e6', olive: '#808000',
    olivedrab: '#6b8e23', orange: '#ffa500', orangered: '#ff4500', orchid: '#da70d6',
    palegoldenrod: '#eee8aa', palegreen: '#98fb98', paleturquoise: '#afeeee', palevioletred: '#db7093',
    papayawhip: '#ffefd5', peachpuff: '#ffdab9', peru: '#cd853f', pink: '#ffc0cb',
    plum: '#dda0dd', powderblue: '#b0e0e6', purple: '#800080', rebeccapurple: '#663399',
    red: '#ff0000', rosybrown: '#bc8f8f', royalblue: '#4169e1', saddlebrown: '#8b4513',
    salmon: '#fa8072', sandybrown: '#f4a460', seagreen: '#2e8b57', seashell: '#fff5ee',
    sienna: '#a0522d', silver: '#c0c0c0', skyblue: '#87ceeb', slateblue: '#6a5acd',
    slategray: '#708090', slategrey: '#708090', snow: '#fffafa', springgreen: '#00ff7f',
    steelblue: '#4682b4', tan: '#d2b48c', teal: '#008080', thistle: '#d8bfd8',
    tomato: '#ff6347', turquoise: '#40e0d0', violet: '#ee82ee', wheat: '#f5deb3',
    white: '#ffffff', whitesmoke: '#f5f5f5', yellow: '#ffff00', yellowgreen: '#9acd32',
    transparent: '#00000000'
};

// ============================================================================
// 4. PARSERS
// ============================================================================

/**
 * Parses a CSS hex string (`#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`) into an
 * OKLCH triplet at `outBuf[offset..offset+2]`.
 *
 * @param {string} str - The hex string (with leading `#`)
 * @param {Float32Array} outBuf - Pre-allocated destination
 * @param {number} offset - Start index of the L, C, H triplet
 * @returns {number} Parsed alpha in [0, 1]; defaults to `1.0` when omitted.
 * @throws If `str` is not a valid hex literal.
 */
export const parseHexToBuffer = (str, outBuf, offset) => {
    let match = str.match(HEX_REGEX);
    if (!match) {
        match = str.match(SHORT_HEX_REGEX);
        if (!match) throw new Error(`lite-color-engine: Invalid HEX "${str}"`);
        match = [
            match[0], match[1] + match[1], match[2] + match[2],
            match[3] + match[3], match[4] ? match[4] + match[4] : undefined
        ];
    }
    sRgbToOklchBuffer(parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16), outBuf, offset);
    return match[4] ? parseInt(match[4], 16) / 255 : 1.0;
};

/**
 * Parses a CSS `oklch()` string directly into an OKLCH triplet - no color-space
 * conversion needed.
 *
 * Accepts the modern slash-alpha form: `oklch(60% 0.15 250 / 0.5)`. Hue may
 * carry a `deg`, `rad`, or `turn` unit.
 *
 * @param {string} str - The `oklch(...)` string
 * @param {Float32Array} outBuf - Pre-allocated destination
 * @param {number} offset - Start index of the L, C, H triplet
 * @returns {number} Parsed alpha in [0, 1]; defaults to `1.0` when omitted.
 * @throws If `str` does not match `oklch(...)`.
 */
export const parseOklchToBuffer = (str, outBuf, offset) => {
    const match = str.match(OKLCH_REGEX);
    if (!match) throw new Error(`lite-color-engine: Invalid OKLCH "${str}"`);
    outBuf[offset] = parseVal(match[1], 1);
    outBuf[offset + 1] = parseVal(match[2], 1);
    outBuf[offset + 2] = parseHue(match[3]);
    return parseVal(match[4], 1) ?? 1.0;
};

/**
 * Parses a CSS `oklab()` string and converts (a, b) -> (C, H) via polar math
 * before writing the OKLCH triplet.
 *
 * @param {string} str - The `oklab(...)` string
 * @param {Float32Array} outBuf - Pre-allocated destination
 * @param {number} offset - Start index of the L, C, H triplet
 * @returns {number} Parsed alpha in [0, 1]; defaults to `1.0` when omitted.
 * @throws If `str` does not match `oklab(...)`.
 */
export const parseOklabToBuffer = (str, outBuf, offset) => {
    const match = str.match(OKLAB_REGEX);
    if (!match) throw new Error(`lite-color-engine: Invalid OKLAB "${str}"`);
    const l = parseVal(match[1], 1);
    const a = parseFloat(match[2]);
    const b = parseFloat(match[3]);
    const c = Math.sqrt(a * a + b * b);

    outBuf[offset] = l < 0 ? 0 : (l > 1 ? 1 : l);
    outBuf[offset + 1] = c || 0;
    let h = Math.atan2(b, a) * RAD_TO_DEG;
    if (h < 0) h += 360;
    outBuf[offset + 2] = h;

    return parseVal(match[4], 1) ?? 1.0;
};

/**
 * Parses a CSS `rgb()` / `rgba()` string and converts to OKLCH.
 *
 * Accepts comma-separated and modern slash-alpha forms, with `0-255` or `%`
 * channel values. Conversion uses the proper sRGB linearization.
 *
 * @param {string} str - The `rgb(...)` / `rgba(...)` string
 * @param {Float32Array} outBuf - Pre-allocated destination
 * @param {number} offset - Start index of the L, C, H triplet
 * @returns {number} Parsed alpha in [0, 1]; defaults to `1.0` when omitted.
 * @throws If `str` does not match `rgb(...)` / `rgba(...)`.
 */
export const parseRgbToBuffer = (str, outBuf, offset) => {
    const match = str.match(RGB_REGEX);
    if (!match) throw new Error(`lite-color-engine: Invalid RGB "${str}"`);
    sRgbToOklchBuffer(parseVal(match[1], 255), parseVal(match[2], 255), parseVal(match[3], 255), outBuf, offset);
    return parseVal(match[4], 1) ?? 1.0;
};

/**
 * Parses a CSS `hsl()` / `hsla()` string, converts via sRGB, and writes the
 * OKLCH triplet.
 *
 * @param {string} str - The `hsl(...)` / `hsla(...)` string
 * @param {Float32Array} outBuf - Pre-allocated destination
 * @param {number} offset - Start index of the L, C, H triplet
 * @returns {number} Parsed alpha in [0, 1]; defaults to `1.0` when omitted.
 * @throws If `str` does not match `hsl(...)` / `hsla(...)`.
 */
export const parseHslToBuffer = (str, outBuf, offset) => {
    const match = str.match(HSL_REGEX);
    if (!match) throw new Error(`lite-color-engine: Invalid HSL "${str}"`);
    const [r, g, b] = hslToRgb(parseHue(match[1]), parseVal(match[2], 1), parseVal(match[3], 1));
    sRgbToOklchBuffer(r, g, b, outBuf, offset);
    return parseVal(match[4], 1) ?? 1.0;
};

/**
 * Parses a CSS `color(display-p3 r g b / alpha?)` string into an OKLCH triplet.
 *
 * Supports modern slash-alpha syntax and percentage components (0%-100%).
 * Components are interpreted in the Display P3 color space (gamma-encoded,
 * same transfer function as sRGB).
 *
 * This is the authoring-time entry point for wide-gamut colors. The resulting
 * OKLCH may have higher chroma than sRGB-gamut colors.
 *
 * @param {string} str - The `color(display-p3 ...)` string
 * @param {Float32Array} outBuf - Pre-allocated destination
 * @param {number} offset - Start index of the L, C, H triplet
 * @returns {number} Parsed alpha in [0, 1]; defaults to `1.0` when omitted.
 * @throws If `str` does not match the expected syntax.
 */
export const parseDisplayP3ToBuffer = (str, outBuf, offset) => {
    const match = str.match(DISPLAY_P3_REGEX);
    if (!match) throw new Error(`lite-color-engine: Invalid display-p3 color "${str}"`);

    // Parse components (0-1 range, with % support) then scale to byte range
    // for consistency with displayP3ToOklchBuffer / sRgbToOklchBuffer
    const r = parseVal(match[1], 1) * 255;
    const g = parseVal(match[2], 1) * 255;
    const b = parseVal(match[3], 1) * 255;

    // Accurate Display P3 -> OKLCH path (Session 2)
    displayP3ToOklchBuffer(r, g, b, outBuf, offset);

    return parseVal(match[4], 1) ?? 1.0;
};

// ============================================================================
// 5. MASTER SWITCHBOARD
// ============================================================================

/**
 * Universal CSS color parser. Dispatches by string prefix to the appropriate
 * format-specific parser and writes an OKLCH triplet.
 *
 * Supports: named colors, `#RGB[A]`, `#RRGGBB[AA]`, `rgb()` / `rgba()`,
 * `hsl()` / `hsla()`, `oklch()`, `oklab()`, `color(display-p3 r g b / alpha?)`.
 *
 * Intended for the **authoring/init phase** of a render pipeline (level loads,
 * theme parsing, gradient compilation). After that, work with the resulting
 * `Float32Array` buffer directly via {@link lerpOklchBuffer} and
 * {@link packOklchBufferToUint32}.
 *
 * `color(display-p3 ...)` is opt-in wide-gamut input. It never affects the
 * default sRGB hot path.
 *
 * @param {string} str - The CSS color string
 * @param {Float32Array} outBuf - Pre-allocated destination
 * @param {number} offset - Start index of the L, C, H triplet
 * @returns {number} Parsed alpha in [0, 1]
 * @throws If `str` is not a recognized format
 */
export const parseCSSColor = (str, outBuf, offset) => {
    const cleanStr = str.trim().toLowerCase();

    const named = NAMED_COLORS[cleanStr];
    if (named) {
        return parseHexToBuffer(named, outBuf, offset);
    }

    if (cleanStr.startsWith('#')) return parseHexToBuffer(cleanStr, outBuf, offset);
    if (cleanStr.startsWith('oklch')) return parseOklchToBuffer(cleanStr, outBuf, offset);
    if (cleanStr.startsWith('oklab')) return parseOklabToBuffer(cleanStr, outBuf, offset);
    if (cleanStr.startsWith('rgb')) return parseRgbToBuffer(cleanStr, outBuf, offset);
    if (cleanStr.startsWith('hsl')) return parseHslToBuffer(cleanStr, outBuf, offset);
    if (cleanStr.startsWith('color(') && cleanStr.includes('display-p3')) {
        return parseDisplayP3ToBuffer(cleanStr, outBuf, offset);
    }

    throw new Error(`lite-color-engine: Unsupported color format "${str}".`);
};

// ============================================================================
// 6. FORMATTERS (round-trip emit - authoring layer, string allocation is fine)
// ============================================================================

/**
 * Emits a modern CSS `oklch(...)` string from an OKLCH buffer triplet.
 * Suitable for exports, CSS custom properties, gradient studios, telemetry, etc.
 *
 * Lightness is emitted as a percentage (e.g. `60.0%`), chroma and hue with
 * enough precision to round-trip through `parseOklchToBuffer`/`parseCSSColor`.
 * Alpha is included only when supplied and below 1.
 *
 * This is an authoring-time helper: it allocates a string and is not intended
 * for per-frame hot paths.
 *
 * @param {Float32Array} buf - Buffer containing [L, C, H]
 * @param {number} off - Offset of the triplet
 * @param {number} [alpha] - Optional alpha [0, 1]. Omitted from output when >= 0.9995 or not supplied.
 * @returns {string} e.g. "oklch(60.0% 0.150 250.0)" or with " / 0.800"
 */
export const formatOklchCss = (buf, off, alpha) => {
    const l = buf[off] * 100;
    const c = buf[off + 1];
    const h = buf[off + 2];
    let s = `oklch(${l.toFixed(1)}% ${c.toFixed(3)} ${h.toFixed(1)})`;
    if (alpha != null && alpha < 0.9995) {
        s += ` / ${alpha.toFixed(3)}`;
    }
    return s;
};

/**
 * Converts an OKLCH buffer triplet to a 6-digit `#rrggbb` hex string (no alpha).
 *
 * Uses the accurate sRGB transfer + pack path, so it round-trips with
 * `parseHexToBuffer` + `packOklchBufferToUint32` to within 1 LSB per channel
 * (the accurate packer's rounding tolerance). Out-of-sRGB-gamut input is hard
 * clamped, matching the packer.
 *
 * Authoring-time helper: allocates a string, not for per-frame hot paths.
 *
 * @param {Float32Array} buf - Buffer containing [L, C, H]
 * @param {number} off - Offset of the triplet
 * @returns {string} e.g. "#ff0000"
 */
export const formatHex = (buf, off) => {
    const u = packOklchBufferToUint32(buf, off);
    const r = u & 0xff;
    const g = (u >>> 8) & 0xff;
    const b = (u >>> 16) & 0xff;
    return '#' +
        r.toString(16).padStart(2, '0') +
        g.toString(16).padStart(2, '0') +
        b.toString(16).padStart(2, '0');
};
