// src/core/redact.ts — credential redaction, binary-payload omission and control-char
// hygiene for rendered Markdown.
//
// WHY THIS EXISTS
// ---------------
// ace writes rendered transcripts to a Google Drive folder on a *work* account. Agent
// transcripts routinely contain `cat .env` tool output, `curl -H "Authorization: …"`
// invocations, pasted API keys and, in at least one observed case, an SSH private key.
// Rendering those verbatim is third-party egress of live credentials.
//
// DESIGN
// ------
// Credential rules are a plain data table (`CREDENTIAL_RULES`) so a new provider is a
// one-line addition. Every rule has:
// Binary/image payload omission is NOT table-driven — see `omitBinaryPayloads`.
//
//   hint / hintRe   a zero-allocation prefilter (`String.includes` / `RegExp.test`) so a
//                   document that never says `sk-ant-` never runs that pattern.
//   pattern         a /g regex that locates *candidates*.
//   accept          an optional gate rejecting false positives using length, charset,
//                   Shannon entropy, placeholder shape and — for JWTs — real base64url
//                   header decoding.
//   replace         builds an informative, non-recoverable replacement.
//
// Replacements keep the *class prefix*, which is public knowledge (`sk-ant-api03-`), and
// drop the secret body entirely:
//
//   sk-ant-api03-‹redacted:ANTHROPIC_API_KEY›
//
// No portion of the body survives, so nothing can be reconstructed. Byte length is
// deliberately not preserved.
//
// BIAS
// ----
// The harm is asymmetric: leaking one live key to a third party is far worse than
// redacting one line of documentation. Where a gate is a judgement call this module
// prefers to over-redact, and says so at the rule.
//
// IDEMPOTENCE
// -----------
// The marker uses U+2039/U+203A (‹›), which appear in no secret charset, and
// `looksLikePlaceholder` rejects anything containing "redacted". Sanitizing an already
// sanitized document is a no-op, which is what lets the pass run at two layers (markdown
// primitives and whole document) without double-mangling.
//
// SCOPE
// -----
// This protects FUTURE renders only. Notes already written to Drive are untouched and need
// separate remediation (delete/re-render) plus rotation of the exposed keys.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One rule that fired, with how many times. Never contains secret material. */
export interface RedactionHit {
  rule: string;
  count: number;
}

export interface RedactionResult {
  text: string;
  hits: RedactionHit[];
}

/** Capture groups of a match: `[0]` is the whole match, `[n]` is group n. */
export type MatchGroups = readonly (string | undefined)[];

export interface RedactionRule {
  /** Reported in `hits[].rule`. Uppercase snake class name. */
  readonly rule: string;
  /** Cheap case-sensitive substring prefilter. */
  readonly hint?: string;
  /** Cheap prefilter for case-insensitive or alternated tokens. Non-global. */
  readonly hintRe?: RegExp;
  /** Candidate locator. MUST carry the `g` flag. */
  readonly pattern: RegExp;
  /** False-positive gate. Returning false leaves the match untouched. */
  readonly accept?: (m: MatchGroups) => boolean;
  /** Builds the replacement text. */
  readonly replace: (m: MatchGroups) => string;
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

const MARK_OPEN = "\u2039redacted:";
const MARK_CLOSE = "\u203a";

/**
 * Renders the redaction marker `‹redacted:CLASS›`. Used by every rule, so the delimiters
 * — which are load-bearing for idempotence, because they appear in no secret charset —
 * are defined exactly once.
 */
function mark(label: string): string {
  return MARK_OPEN + label + MARK_CLOSE;
}

/**
 * Marker for omitted image payloads. Byte-identical to the string used by the sibling
 * Python renderer so the two corpora stay lexically consistent.
 */
export const IMAGE_OMITTED = "*[image content omitted]*";

/** Marker for omitted non-image encoded blobs. */
export const BINARY_OMITTED = "*[binary content omitted]*";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Minimum length of a *contextless* contiguous base64-charset run before it is treated as
 * an encoded binary payload.
 *
 * 512 is chosen because every plausible legitimate long token sits comfortably below it: a
 * git SHA-1 is 40 chars, SHA-256 hex 64, SHA-512 hex 128, a base64-encoded 256-bit key 44;
 * a UUID contains dashes and a JWT contains dots, both of which break the run. Minified JS
 * and long source lines are dense with punctuation, so a 512-char run of nothing but
 * `[A-Za-z0-9+/]` does not occur in real code. Meanwhile the smallest useful screenshot PNG
 * is ~2 KB ≈ 2,700 base64 chars, 5× over the bar. The observed worst offender in the
 * corpus was a single 364,558-char line.
 */
export const BASE64_MIN_RUN = 512;

/**
 * Minimum payload length inside a *proven* encoded-payload context (a `data:` URI, or a
 * JSON `"data"` / `"b64_json"` field). Context removes the ambiguity, so a much lower bar
 * is safe and it also catches small icons.
 */
export const BASE64_MIN_FIELD = 64;

/** Base64 of compressed binary sits near 6.0 bits/char; ASCII art and `xxxx…` sit far below. */
const BASE64_MIN_ENTROPY = 3.5;

/** Entropy is sampled rather than measured across a whole multi-hundred-KB blob. */
const ENTROPY_SAMPLE = 4096;

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

/**
 * Shannon entropy in bits/char over the ASCII range, sampled to the first
 * `ENTROPY_SAMPLE` chars. Separates real key bodies (high) from placeholders and prose
 * padding (low). Allocation is one small fixed typed array.
 */
export function shannonEntropy(s: string): number {
  const counts = new Int32Array(128);
  const len = s.length < ENTROPY_SAMPLE ? s.length : ENTROPY_SAMPLE;
  let n = 0;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) {
      counts[c] = (counts[c] ?? 0) + 1;
      n++;
    }
  }
  if (n === 0) return 0;
  let h = 0;
  for (let i = 0; i < 128; i++) {
    const c = counts[i] ?? 0;
    if (c === 0) continue;
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * True when `s` contains an ascending or descending charcode run of `len` or more, i.e.
 * `abcdefg` / `0123456` / `zyxwvut`. Catches hand-typed fixture keys that entropy alone
 * would let through.
 */
function hasSequentialRun(s: string, len: number): boolean {
  let run = 1;
  let dir = 0;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    if ((d === 1 || d === -1) && (dir === 0 || d === dir)) {
      run++;
      dir = d;
    } else if (d === 1 || d === -1) {
      run = 2;
      dir = d;
    } else {
      run = 1;
      dir = 0;
    }
    if (run >= len) return true;
  }
  return false;
}

/**
 * Substrings that only occur in documentation, tests and fixtures. The corpus carries these
 * right next to the real thing (`sk-ant-api03-xxxx…`, `AKIAABCDEFGHIJKLMNOP`), so this is
 * the primary false-positive brake.
 *
 * The chance that a genuinely random 95-char base64url body contains any of them is on the
 * order of 1e-7, so the brake costs essentially no true positives.
 */
const PLACEHOLDER_SUBSTRINGS: readonly string[] = [
  "redacted",
  "placeholder",
  "example",
  "changeme",
  "change-me",
  "yourkey",
  "your-key",
  "your_key",
  "yourtoken",
  "your-token",
  "your_token",
  "yoursecret",
  "your-secret",
  "your_secret",
  "myapikey",
  "dummy",
  "notreal",
  "not-real",
  "fakekey",
  "fake-key",
  "faketoken",
  "sample",
  "insertkey",
  "replaceme",
  "replace-me",
  "abcdef",
  "123456",
  "deadbeef",
  "foobar",
  "lorem",
  "testkey",
  "test-key",
  "test_key",
  "xxxxx",
  "sk-xxx",
  // `ANTHROPIC_API_KEY=your-api-key-here` is the single most common doc shape in the
  // corpus. A random 95-char base64url body contains any of these with probability ~1e-7.
  "your-",
  "your_",
  "yourapi",
  "-here",
  "_here",
  "insert",
  "todo",
  "supersecret",
  "mysecret",
  "mypassword",
];

/** Lexical and shape-level placeholder detection. */
export function looksLikePlaceholder(s: string): boolean {
  const lower = s.toLowerCase();
  for (const w of PLACEHOLDER_SUBSTRINGS) {
    if (lower.includes(w)) return true;
  }
  // 6+ of the same character: `xxxxxx`, `000000`, `------`
  if (/(.)\1{5,}/.test(s)) return true;
  // template, masked or elided value
  if (/[<>{}]|\$\{|\.\.\.|\*\*\*|\u2026/.test(s)) return true;
  return hasSequentialRun(s, 6);
}

/**
 * Assignment right-hand sides that are references or declarations rather than literals.
 * Rejecting these is what keeps `password: str`, `TOKEN=${TOKEN}`,
 * `API_KEY: ${{ secrets.API_KEY }}` and `SECRET_KEY = os.environ["X"]` out of the results.
 */
const NON_SECRET_LITERALS: Record<string, true> = {
  str: true,
  string: true,
  int: true,
  integer: true,
  bool: true,
  boolean: true,
  number: true,
  float: true,
  bytes: true,
  any: true,
  unknown: true,
  object: true,
  dict: true,
  list: true,
  array: true,
  tuple: true,
  none: true,
  null: true,
  nil: true,
  true: true,
  false: true,
  undefined: true,
  optional: true,
  secretstr: true,
  secret: true,
  secrets: true,
  required: true,
  text: true,
  varchar: true,
  uuid: true,
  json: true,
  jsonb: true,
  password: true,
  passwd: true,
  token: true,
  tokens: true,
  apikey: true,
  api_key: true,
  credentials: true,
  keys: true,
  value: true,
  hidden: true,
  readonly: true,
  public: true,
  private: true,
  static: true,
  final: true,
  empty: true,
};

/** True when the assignment right-hand side is not a literal secret. */
export function isNonSecretValue(v: string): boolean {
  if (NON_SECRET_LITERALS[v.toLowerCase()] === true) return true;
  // shell / CI / template indirection
  if (v.startsWith("$")) return true;
  if (v.includes("${") || v.includes("{{")) return true;
  // language-level lookups and calls. The dotted-path test generalises the `os.`/`process.`
  // prefixes: `vi.fn`, `jest.fn`, `payload.accessToken`, `settings.google_client_secret`,
  // `stats.last_sync_token` are all code, and no credential is ever shaped like that.
  if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(v)) return true;
  if (/^(?:getenv|require|import|await|new|Field|z|yup|Joi|String|Number|Boolean)\b/.test(v)) return true;
  if (v.includes("(")) return true;
  // paths and URLs are not the secret itself
  if (/^(?:[~.]?\/|[a-z]:\\|https?:\/\/)/i.test(v)) return true;
  // union type annotations: `str | None`
  if (v.includes("|")) return true;
  return looksLikePlaceholder(v);
}

/**
 * Stricter value gate for the weak `*_KEY` class, where the key name alone is a poor signal
 * (`SORT_KEY`, `PRIMARY_KEY`, `PARTITION_KEY`). Real keys are base62-ish blobs, so this
 * demands digit+letter mixing, mixed case, or sheer length. `created_at` and
 * `user_id_prefix` both fail; a real 32-char key passes.
 */
export function looksHighEntropyValue(v: string): boolean {
  if (v.length >= 32) return true;
  if (v.length < 12) return false;
  const hasDigit = /[0-9]/.test(v);
  const hasAlpha = /[A-Za-z]/.test(v);
  const mixedCase = /[a-z]/.test(v) && /[A-Z]/.test(v);
  return (hasDigit && hasAlpha) || mixedCase;
}

/**
 * True when an assignment value lacks the shape of a *generated* credential: it contains no
 * digit and is under 40 chars.
 *
 * This is the single most important false-positive brake on the assignment rules. Measured
 * against 1.13 GB of real transcripts, the key name alone is a terrible signal, because
 * agent sessions are mostly *code* and code is full of names ending in token/secret/key:
 *
 *   const accessToken = useCallback      credentials: 'include'
 *   refreshToken: payload?.refreshToken  STORAGE_KEY = 'shapekit:builtInCategories'
 *   var errNoToken = errors              automountServiceAccountToken: false
 *   id-token: write                      access-control-allow-credentials: true
 *
 * Earlier revisions gated on the value's charset instead, and every one of those examples
 * defeated it through a `:`, `?`, `/` or JSON `\` that no identifier pattern anticipated.
 * Digit presence is far more robust and far cheaper: a generated 32-char base62 token is
 * digit-free with probability (52/62)^32 ≈ 4e-5, so demanding a digit costs essentially no
 * true positives, while identifiers and English words almost never carry one.
 *
 * The ≥40-char escape hatch covers a hypothetical long digit-free token; a 40-char digit-free
 * value in source code is vanishingly rare.
 *
 * ACCEPTED RESIDUAL MISS: a short digit-free secret under a non-password key
 * (`SESSION_SECRET=MySuperSecretPhrase`) is not redacted. The password family is exempted
 * from this gate precisely because human-chosen passwords are often digit-free words, and a
 * leaked password is the highest-harm, least-ambiguous case.
 */
function lacksGeneratedSecretShape(v: string): boolean {
  if (v.length >= 40) return false;
  return !/[0-9]/.test(v);
}

/** Keys whose values are often digit-free words, exempted from `lacksGeneratedSecretShape`. */
const PASSWORD_FAMILY_KEY = /PASS(?:WORD|WD|PHRASE)$/i;

/**
 * Random enough to be a real key body. Combines the placeholder brake with a per-rule
 * entropy floor, because the floor has to scale with body length: a 16-char AWS suffix
 * cannot exceed log2(16) = 4.0 bits/char, while a 95-char Anthropic body reaches ~5.6.
 */
function looksRandom(s: string, minEntropy: number): boolean {
  if (looksLikePlaceholder(s)) return false;
  return shannonEntropy(s) >= minEntropy;
}

/**
 * Shortest body on which an entropy measurement means anything. A 12-char string cannot
 * exceed log2(12) = 3.58 bits/char, so applying a 3.2 floor to a short fragment rejects
 * genuine material rather than filtering noise.
 */
const ENTROPY_MIN_BODY = 24;

/**
 * Accept gate for rules whose signal is a *decisive vendor prefix* (`sk-ant-api03-`,
 * `github_pat_`, `xoxb-`, `AKIA`, `AIza`, `GOCSPX-`, `glpat-`, `sk_live_`). For these the
 * literal prefix carries the false-positive protection by itself, so the body only has to
 * clear the placeholder brake — and the entropy floor is applied only once the body is long
 * enough for entropy to be meaningful.
 *
 * WHY THE LENGTH FLOOR HAD TO GO: `frontmatter.title` is derived from raw first-message text
 * and truncated mid-token by the sources, and the output *filename* is derived from the
 * title. A title carrying `sk-ant-api03-` + only 8..20 body chars therefore put a live key
 * fragment into a filename on the work Drive, where body redaction cannot reach it. The old
 * `{40,}` / `{50,}` / `{16,}` minimums — chosen from full-length keys — let exactly that
 * range through. A vendor prefix plus 8 non-placeholder chars is already unambiguous, and no
 * benign text contains `sk-ant-api03-`.
 */
function acceptVendorPrefixed(body: string, minEntropy: number): boolean {
  if (looksLikePlaceholder(body)) return false;
  if (body.length < ENTROPY_MIN_BODY) return true;
  return shannonEntropy(body) >= minEntropy;
}

/**
 * A real JWT header segment base64url-decodes to JSON declaring `alg` or `typ`. This is a
 * near-zero-false-positive test and is why the JWT rule needs no entropy gate.
 */
function isJwtHeader(seg: string): boolean {
  try {
    const json = Buffer.from(seg, "base64url").toString("utf8");
    if (!json.startsWith("{")) return false;
    return /"(?:alg|typ)"\s*:/.test(json);
  } catch {
    return false;
  }
}

/**
 * Base64 of real binary is mixed-case and/or uses `+`/`/`. Hex digests (single case) and
 * long snake_case identifiers are not, which is how hashes avoid being mistaken for
 * payloads. A masked run (`xxxx…`, `AAAA…`) is single-case and fails the same test, and
 * anything that slips past is caught by the entropy floor.
 *
 * Deliberately does NOT consult `looksLikePlaceholder`. Those heuristics — "contains
 * `abcdef`", "has a 6-char ascending run" — are calibrated for ~100-char key bodies, where
 * a chance hit is ~1e-7. On a 120 KB image payload the same tests fire by coincidence
 * (measured: they did, on the first realistic payload tried) and the blob silently survives
 * into the note. They are also O(n) with a full lowercase copy, which is wasted work at
 * that size.
 */
function looksLikeEncodedBinary(run: string): boolean {
  const mixedCase = /[a-z]/.test(run) && /[A-Z]/.test(run);
  if (!mixedCase && !/[+/]/.test(run)) return false;
  return shannonEntropy(run) >= BASE64_MIN_ENTROPY;
}

/**
 * Group accessor that collapses the `string | undefined` of an unmatched optional group to
 * `""`. Every rule callback below reads groups through it, so the narrowing lives in one
 * place instead of ~40 `?? ""` sites.
 */
const g = (m: MatchGroups, i: number): string => m[i] ?? "";

// ---------------------------------------------------------------------------
// Binary / image payload scanner
//
// Deliberately NOT regex-based. The first implementation used
// `data:…;base64,[A-Za-z0-9+/]{64,}` and V8 threw `RangeError: Maximum call stack size
// exceeded` on a real 6.7 MB single-line transcript: an unbounded quantifier asked to
// consume a multi-megabyte run blows the regex engine's stack. Bounding the quantifier
// would instead shred one payload into thousands of markers.
//
// A hand-rolled scan is the correct tool: one linear pass, no backtracking, no stack
// growth, and it replaces three full regex passes over multi-MB input. It finds each
// maximal run of the base64 alphabet and classifies it by the ≤96 chars in front of it.
// ---------------------------------------------------------------------------

/** `"data": "` and friends, anchored so it must sit immediately before the run. */
const JSON_PAYLOAD_FIELD_TAIL =
  /"(?:data|b64_json|image_base64|imageData|source_base64)"\s*:\s*"$/;

/** How much text before a run is inspected to classify it. */
const CONTEXT_WINDOW = 96;

/**
 * Replace base64 / binary payloads with a short marker.
 *
 * Three classes, distinguished by the context immediately preceding the run:
 *   DATA_URI_PAYLOAD     after `;base64,` — a `data:` URI. Marker depends on the mime type.
 *   IMAGE_PAYLOAD_FIELD  after `"data": "` etc. Claude/omp `image` content blocks stringify
 *                        to { "source": { "media_type": "image/png", "data": "…" } } and land
 *                        in the drift renderer, which fences the whole object with NO
 *                        truncation — that is the 364,558-char line in the corpus.
 *   BINARY_PAYLOAD       no context; qualifies on length alone (see BASE64_MIN_RUN).
 */
export function omitBinaryPayloads(s: string): RedactionResult {
  const len = s.length;
  let pieces: string[] | undefined;
  let copiedTo = 0;
  let dataUri = 0;
  let imageField = 0;
  let binary = 0;
  let i = 0;

  while (i < len) {
    const c = s.charCodeAt(i);
    // [A-Za-z0-9+/]
    if (
      !((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47)
    ) {
      i++;
      continue;
    }

    // Maximal run of the base64 alphabet, then up to two `=` of padding.
    let runEnd = i + 1;
    while (runEnd < len) {
      const d = s.charCodeAt(runEnd);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 43 || d === 47) {
        runEnd++;
      } else break;
    }
    let end = runEnd;
    while (end < len && end - runEnd < 2 && s.charCodeAt(end) === 61) end++;

    // Short runs are ordinary words; skip before doing any allocation at all.
    if (runEnd - i < BASE64_MIN_FIELD) {
      i = end;
      continue;
    }

    const ctx = s.slice(i > CONTEXT_WINDOW ? i - CONTEXT_WINDOW : 0, i);
    let marker: string;
    let min: number;
    let cls: 0 | 1 | 2;
    if (ctx.toLowerCase().endsWith(";base64,")) {
      cls = 0;
      marker = /data:image\//i.test(ctx) ? IMAGE_OMITTED : BINARY_OMITTED;
      min = BASE64_MIN_FIELD;
    } else if (JSON_PAYLOAD_FIELD_TAIL.test(ctx)) {
      cls = 1;
      marker = IMAGE_OMITTED;
      min = BASE64_MIN_FIELD;
    } else {
      cls = 2;
      marker = BINARY_OMITTED;
      min = BASE64_MIN_RUN;
    }

    // Charset/entropy checks read a bounded prefix — never a multi-MB copy of the run.
    const sample = s.slice(i, runEnd < i + ENTROPY_SAMPLE ? runEnd : i + ENTROPY_SAMPLE);
    if (runEnd - i < min || !looksLikeEncodedBinary(sample)) {
      i = end;
      continue;
    }

    pieces ??= [];
    pieces.push(s.slice(copiedTo, i), marker);
    copiedTo = end;
    if (cls === 0) dataUri++;
    else if (cls === 1) imageField++;
    else binary++;
    i = end;
  }

  if (pieces === undefined) return { text: s, hits: [] };
  pieces.push(s.slice(copiedTo));
  const hits: RedactionHit[] = [];
  if (dataUri > 0) hits.push({ rule: "DATA_URI_PAYLOAD", count: dataUri });
  if (imageField > 0) hits.push({ rule: "IMAGE_PAYLOAD_FIELD", count: imageField });
  if (binary > 0) hits.push({ rule: "BINARY_PAYLOAD", count: binary });
  return { text: pieces.join(""), hits };
}

// ---------------------------------------------------------------------------
// Credential rules
//
// Order is load-bearing, specific → generic:
//   1. private key material   (whole blocks, before anything can nibble at the body)
//   2. transport wrappers     (Authorization/headers/URL creds — redacting the wrapper
//                              first yields one clean marker instead of two nested ones)
//   3. provider prefixes      (highest confidence, exact known shapes)
//   4. JWTs
//   5. keyed assignments      (broadest, lowest confidence, last)
//
// Because every replacement injects U+2039, which is outside every secret charset, a later
// generic rule can never re-match an earlier rule's output.
// ---------------------------------------------------------------------------

export const CREDENTIAL_RULES: readonly RedactionRule[] = [
  // --- 1. private key material --------------------------------------------
  // Whole BEGIN…END block, non-greedy so two adjacent keys are two matches. Also covers
  // the JSON-escaped service-account form, where the literal text still contains
  // `-----END PRIVATE KEY-----` and only the newlines are escaped.
  {
    rule: "PRIVATE_KEY_BLOCK",
    hint: "PRIVATE KEY-----",
    pattern:
      /-----BEGIN ([A-Z0-9 ]*?)PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*?PRIVATE KEY-----/g,
    // The replacement is itself a BEGIN…END block, so without this guard a second pass
    // would report a phantom hit (the text is stable either way).
    accept: (m) => !g(m, 0).includes(MARK_OPEN),
    replace: (m) =>
      `-----BEGIN ${g(m, 1)}PRIVATE KEY-----\n${mark("PRIVATE_KEY")}\n-----END ${g(m, 1)}PRIVATE KEY-----`,
  },
  // Truncated block: a BEGIN whose END was cut off by tool-output truncation. Matched as
  // "header plus the following base64 lines" rather than "header to end of input", so it
  // can never swallow the rest of the document — and so it cannot re-match the rule above's
  // output, whose body line starts with `‹`.
  {
    rule: "PRIVATE_KEY_BODY_UNTERMINATED",
    hint: "PRIVATE KEY-----",
    pattern: /-----BEGIN ([A-Z0-9 ]*?)PRIVATE KEY-----[ \t]*\n(?:[A-Za-z0-9+/=]{16,}[ \t]*\n?)+/g,
    replace: (m) => `-----BEGIN ${g(m, 1)}PRIVATE KEY-----\n${mark("PRIVATE_KEY")}\n`,
  },
  {
    rule: "AGE_SECRET_KEY",
    hint: "AGE-SECRET-KEY-1",
    pattern: /AGE-SECRET-KEY-1[A-Z0-9]{50,}/g,
    replace: () => `AGE-SECRET-KEY-1${mark("AGE_SECRET_KEY")}`,
  },

  // --- 2. transport wrappers ----------------------------------------------
  {
    rule: "AUTHORIZATION_HEADER",
    hintRe: /authorization/i,
    pattern:
      /\b((?:proxy-)?authorization)([ \t]*:[ \t]*(?:\\?["'])?)(bearer|basic|token|apikey)([ \t]+)([A-Za-z0-9._~+/=-]{8,})/gi,
    accept: (m) => !looksLikePlaceholder(g(m, 5)),
    replace: (m) => `${g(m, 1)}${g(m, 2)}${g(m, 3)}${g(m, 4)}${mark("AUTHORIZATION_HEADER")}`,
  },
  {
    rule: "SECRET_HEADER",
    hintRe: /x-(?:api-key|auth-token|amz-security-token)|private-token|api-key/i,
    pattern:
      /\b(x-api-key|x-auth-token|x-amz-security-token|private-token|api-key)([ \t]*:[ \t]*(?:\\?["'])?)([^\s"'`\\\n]{8,})/gi,
    accept: (m) => !isNonSecretValue(g(m, 3)),
    replace: (m) => `${g(m, 1)}${g(m, 2)}${mark("SECRET_HEADER")}`,
  },
  // Credentials embedded in a URL: `postgres://user:pass@host`, `https://x:y@host`.
  // Database connection strings are the highest-frequency form of this in the corpus.
  {
    rule: "URL_CREDENTIALS",
    hint: "://",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@'"]{1,64}):([^\s:/@'"]{3,128})@/gi,
    accept: (m) => !isNonSecretValue(g(m, 3)),
    replace: (m) => `${g(m, 1)}${g(m, 2)}:${mark("URL_PASSWORD")}@`,
  },

  // --- 3. provider prefixes -----------------------------------------------
  // Bodies are captured as their own group rather than sliced off the whole match, so a gate
  // never depends on prefix-length arithmetic.
  //
  // Anthropic, observed at exactly 108 chars: `sk-ant-api03-` (13) + 95 base64url. The body
  // minimum is 8, not 95 — see `acceptVendorPrefixed` for why truncated fragments matter.
  {
    rule: "ANTHROPIC_API_KEY",
    hint: "sk-ant-",
    pattern: /sk-ant-([a-z]{3,6}\d{2})-([A-Za-z0-9_-]{8,})/g,
    accept: (m) => acceptVendorPrefixed(g(m, 2), 3.2),
    replace: (m) => `sk-ant-${g(m, 1)}-${mark("ANTHROPIC_API_KEY")}`,
  },
  {
    rule: "OPENROUTER_API_KEY",
    hint: "sk-or-v1-",
    pattern: /sk-or-v1-([A-Za-z0-9]{8,})/g,
    accept: (m) => acceptVendorPrefixed(g(m, 1), 3.0),
    replace: () => `sk-or-v1-${mark("OPENROUTER_API_KEY")}`,
  },
  // Generic OpenAI-compatible `sk-`, incl. `sk-proj-` / `sk-svcacct-` / legacy 48-char.
  // Keeps a long minimum: bare `sk-` is NOT a decisive prefix, so length and entropy are
  // still carrying the false-positive protection here.
  {
    rule: "OPENAI_API_KEY",
    hint: "sk-",
    pattern: /\bsk-(proj|svcacct|admin)?-?[A-Za-z0-9_-]{32,}/g,
    accept: (m) => looksRandom(g(m, 0), 3.5),
    replace: (m) => {
      const kind = g(m, 1);
      return `sk-${kind === "" ? "" : kind + "-"}${mark("OPENAI_API_KEY")}`;
    },
  },
  // GitHub fine-grained PAT, observed at 93 chars: `github_pat_` (11) + 82.
  {
    rule: "GITHUB_PAT",
    hint: "github_pat_",
    pattern: /github_pat_([A-Za-z0-9_]{8,})/g,
    accept: (m) => acceptVendorPrefixed(g(m, 1), 3.2),
    replace: () => `github_pat_${mark("GITHUB_PAT")}`,
  },
  // Classic GitHub tokens: 4-char prefix + base62 body.
  {
    rule: "GITHUB_TOKEN",
    hintRe: /gh[posur]_/,
    pattern: /\b(gh[posur]_)([A-Za-z0-9]{8,255})\b/g,
    accept: (m) => acceptVendorPrefixed(g(m, 2), 3.0),
    replace: (m) => `${g(m, 1)}${mark("GITHUB_TOKEN")}`,
  },
  {
    rule: "GITLAB_TOKEN",
    hint: "glpat-",
    pattern: /\bglpat-([A-Za-z0-9_-]{8,})/g,
    accept: (m) => acceptVendorPrefixed(g(m, 1), 3.0),
    replace: () => `glpat-${mark("GITLAB_TOKEN")}`,
  },
  // Slack bot/user/app tokens, observed at 59 chars. Every real one is
  // `xox?-<numeric team id>-<numeric id>-<secret>`, so the body MUST start with a digit.
  //
  // That leading-digit requirement is load-bearing, not decoration. Lowering the body
  // minimum to 8 without it produced 108 false positives across the audit corpus — every
  // single one a digit-free 10-12 char fixture (`xoxp-test-token` and friends), and not one
  // of them matching the real token shape.
  {
    rule: "SLACK_TOKEN",
    hint: "xox",
    pattern: /\b(xox[abeoprs]-)(\d[A-Za-z0-9-]{7,})/g,
    accept: (m) => acceptVendorPrefixed(g(m, 2), 3.0),
    replace: (m) => `${g(m, 1)}${mark("SLACK_TOKEN")}`,
  },
  {
    rule: "SLACK_APP_TOKEN",
    hint: "xapp-",
    pattern: /\bxapp-\d-[A-Za-z0-9]+-\d+-[A-Za-z0-9]{32,}/g,
    replace: () => `xapp-${mark("SLACK_APP_TOKEN")}`,
  },
  {
    rule: "SLACK_WEBHOOK_URL",
    hint: "hooks.slack.com",
    pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_+-]{20,}/g,
    replace: () => `https://hooks.slack.com/services/${mark("SLACK_WEBHOOK_URL")}`,
  },
  // AWS access key IDs are 20 chars in full: 4-char prefix + 16 uppercase base36, but a
  // truncated fragment is matched too (8+ body chars).
  //
  // ONLY `AKIA` (long-term access key) and `ASIA` (temporary STS key) are matched, because
  // only those two are credentials. `AIDA`/`AROA`/`ANPA`/`ANVA`/`ACCA`/`ABIA` are IAM
  // *entity* unique-ID prefixes (user, role, managed policy, policy version, certificate,
  // bearer token) — public identifiers that show up in ARNs and CloudTrail. Including them
  // produced 6 false positives in the audit corpus, all from CI log lines reading
  // `Authenticated as assumedRoleId AROA…`, which leak nothing.
  //
  // AWS's own docs use AKIAIOSFODNN7EXAMPLE and AKIAI44QH8DHBEXAMPLE, both caught by the
  // "example" placeholder substring; `AKIAABCDEFGHIJKLMNOP` is caught by the sequential-run
  // check.
  {
    rule: "AWS_ACCESS_KEY_ID",
    hintRe: /A[KS]IA/,
    pattern: /\b(AKIA|ASIA)([A-Z0-9]{8,})\b/g,
    accept: (m) => acceptVendorPrefixed(g(m, 2), 2.6),
    replace: (m) => `${g(m, 1)}${mark("AWS_ACCESS_KEY_ID")}`,
  },
  // Secret access keys are 40 chars of base64 charset with no distinguishing prefix, so
  // matching them bare would flag every SHA-1 and short base64 blob in the corpus. Matched
  // only in a keyed context, which is exactly how they appear (`~/.aws/credentials`, env
  // dumps, `aws configure` transcripts).
  {
    rule: "AWS_SECRET_ACCESS_KEY",
    hintRe: /secret_access_key/i,
    pattern: /\b(aws_secret_access_key)([ \t]*[:=][ \t]*)(["']?)([A-Za-z0-9/+=]{40})\3/gi,
    accept: (m) => !looksLikePlaceholder(g(m, 4)),
    replace: (m) =>
      `${g(m, 1)}${g(m, 2)}${g(m, 3)}${mark("AWS_SECRET_ACCESS_KEY")}${g(m, 3)}`,
  },
  // Google API keys are exactly 39 chars in full: `AIza` + 35.
  {
    rule: "GOOGLE_API_KEY",
    hint: "AIza",
    // The `AIza` prefix plus the placeholder brake is decisive on its own, so the body
    // minimum is 8 — enough to also catch a title-truncated fragment.
    pattern: /\bAIza([A-Za-z0-9_-]{8,})\b/g,
    accept: (m) => acceptVendorPrefixed(g(m, 1), 2.8),
    replace: () => `AIza${mark("GOOGLE_API_KEY")}`,
  },
  {
    rule: "GOOGLE_OAUTH_CLIENT_SECRET",
    hint: "GOCSPX-",
    pattern: /\bGOCSPX-([A-Za-z0-9_-]{8,})/g,
    accept: (m) => acceptVendorPrefixed(g(m, 1), 2.8),
    replace: () => `GOCSPX-${mark("GOOGLE_OAUTH_CLIENT_SECRET")}`,
  },
  // Google OAuth refresh tokens are `1//0` plus a long base64url body.
  {
    rule: "GOOGLE_OAUTH_REFRESH_TOKEN",
    hint: "1//0",
    pattern: /\b1\/\/0[A-Za-z0-9_-]{30,}/g,
    accept: (m) => looksRandom(g(m, 0).slice(4), 3.0),
    replace: () => `1//0${mark("GOOGLE_OAUTH_REFRESH_TOKEN")}`,
  },
  {
    rule: "HUGGINGFACE_TOKEN",
    hint: "hf_",
    pattern: /\bhf_[A-Za-z0-9]{30,}\b/g,
    accept: (m) => looksRandom(g(m, 0).slice(3), 3.0),
    replace: () => `hf_${mark("HUGGINGFACE_TOKEN")}`,
  },
  {
    rule: "STRIPE_SECRET_KEY",
    hintRe: /(?:sk|rk)_(?:live|test)_|whsec_/,
    pattern: /\b(sk_live_|sk_test_|rk_live_|rk_test_|whsec_)([A-Za-z0-9]{8,})/g,
    accept: (m) => acceptVendorPrefixed(g(m, 2), 3.0),
    replace: (m) => `${g(m, 1)}${mark("STRIPE_SECRET_KEY")}`,
  },
  {
    rule: "SENDGRID_API_KEY",
    hint: "SG.",
    pattern: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
    replace: () => `SG.${mark("SENDGRID_API_KEY")}`,
  },
  {
    rule: "NPM_TOKEN",
    hint: "npm_",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    accept: (m) => looksRandom(g(m, 0).slice(4), 3.0),
    replace: () => `npm_${mark("NPM_TOKEN")}`,
  },
  {
    rule: "DIGITALOCEAN_TOKEN",
    hintRe: /do[op]_v1_/,
    pattern: /\b(do[op]_v1_)[a-f0-9]{64}\b/g,
    replace: (m) => `${g(m, 1)}${mark("DIGITALOCEAN_TOKEN")}`,
  },
  {
    rule: "SHOPIFY_TOKEN",
    hint: "shp",
    pattern: /\b(shp(?:at|ca|pa|ss)_)[a-fA-F0-9]{32}\b/g,
    replace: (m) => `${g(m, 1)}${mark("SHOPIFY_TOKEN")}`,
  },
  // Cloudflare API tokens are 40 chars of `[A-Za-z0-9_-]` with no prefix, which is
  // indistinguishable from a base64 digest, so they are deliberately left to
  // SECRET_ASSIGNMENT (`CLOUDFLARE_API_TOKEN=…`) and AUTHORIZATION_HEADER — the two forms
  // they actually appear in. Only the prefixed Origin CA key is matched bare.
  {
    rule: "CLOUDFLARE_ORIGIN_CA_KEY",
    hint: "v1.0-",
    pattern: /\bv1\.0-[a-f0-9]{24}-[A-Za-z0-9+/=]{140,}/g,
    replace: () => `v1.0-${mark("CLOUDFLARE_ORIGIN_CA_KEY")}`,
  },

  // --- 4. JWTs -------------------------------------------------------------
  // 256 corpus files carry these. The header segment is decoded and checked for `alg`/`typ`,
  // so `eyJ`-prefixed non-JWT base64 (and `eyJ…` placeholders) do not match.
  {
    rule: "JWT",
    hint: "eyJ",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
    accept: (m) => {
      const seg = g(m, 0).split(".")[0];
      return seg !== undefined && isJwtHeader(seg);
    },
    replace: () => `eyJ${mark("JWT")}`,
  },

  // --- 5. `.env`-style assignments ----------------------------------------
  // 331 corpus files. Strong class: the key name is itself decisive
  // (POSTGRES_PASSWORD, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, CLOUDFLARE_API_TOKEN,
  // ANTHROPIC_API_KEY, SESSION_SECRET, *_JWT_SECRET, …), so the value gate only has to
  // reject references, type annotations and placeholders. The value charset excludes
  // brackets, braces and angle brackets so expressions like `tokens[0]` cannot match
  // wholesale.
  //
  // The suffix must *end* the key, so `PRIVATE_KEY_PATH` and `API_TOKEN_URL` do not match.
  // The replacement keeps the key name — an env var name is not sensitive and is the most
  // useful thing to report.
  {
    rule: "SECRET_ASSIGNMENT",
    hintRe: /pass|secret|token|credential|api_?key|access_?key|private_?key|passphrase/i,
    // `PAT` is deliberately absent from the alternation: as a bare suffix it fires inside
    // ordinary words and names — `back-compat`, `uselibpqcompat`, `signedUpAt`, `link_pat`
    // (a regex variable) — all observed in the corpus. Real GitHub PATs are caught by their
    // `github_pat_` / `ghp_` prefixes and by `*_TOKEN=`.
    // The value charset excludes `\`, and the optional quote may itself be JSON-escaped.
    // Transcripts are full of JSON-embedded text, so without this the value swallows the
    // escape sequence — `id-token: write\n` captured `write\n`, whose stray backslash then
    // defeated the code-or-word gate and got `write` redacted. A real credential never
    // contains a backslash, so treating one as a terminator is free.
    pattern:
      /\b([A-Za-z0-9_.-]*(?:PASSWORD|PASSWD|PASSPHRASE|CLIENT_SECRET|SESSION_SECRET|JWT_SECRET|REFRESH_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN|API_TOKEN|SECRET_ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|SIGNING_KEY|ENCRYPTION_KEY|API_?KEY|ACCESS_?KEY|CREDENTIALS|CREDENTIAL|SECRET|TOKEN))([ \t]*[:=][ \t]*)(\\?["'])?([^\s"'`\\\n#,;()[\]{}<>]{6,})\3/gi,
    accept: (m) => {
      const value = g(m, 4);
      if (isNonSecretValue(value)) return false;
      if (PASSWORD_FAMILY_KEY.test(g(m, 1))) return true;
      return !lacksGeneratedSecretShape(value);
    },
    replace: (m) =>
      `${g(m, 1)}${g(m, 2)}${g(m, 3)}${mark(g(m, 1).toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}${g(m, 3)}`,
  },
  // Weak class: a generic SCREAMING_SNAKE `*_KEY`, where the name is a poor signal
  // (SORT_KEY, PRIMARY_KEY, PARTITION_KEY). Requires an all-caps key *and* a
  // high-entropy-shaped value, which is what keeps `SORT_KEY=created_at` intact.
  {
    rule: "KEY_ASSIGNMENT",
    hint: "KEY",
    pattern:
      /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_KEY)([ \t]*[:=][ \t]*)(\\?["'])?([^\s"'`\\\n#,;()[\]{}<>]{8,})\3/g,
    accept: (m) => {
      const value = g(m, 4);
      return (
        !isNonSecretValue(value) &&
        !lacksGeneratedSecretShape(value) &&
        looksHighEntropyValue(value)
      );
    },
    replace: (m) => `${g(m, 1)}${g(m, 2)}${g(m, 3)}${mark(g(m, 1))}${g(m, 3)}`,
  },
];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * C0 control characters other than `\t` (0x09) and `\n` (0x0A), plus DEL.
 *
 * Four notes in the existing corpus contain NUL bytes, which makes `grep` classify the
 * whole file as binary and silently drop it from lexical search — the note becomes
 * invisible. `\r` is dropped too: in Markdown it is CRLF noise.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/** Remove NUL and other C0 controls, preserving `\n` and `\t`. */
export function stripControlChars(s: string): RedactionResult {
  CONTROL_CHARS.lastIndex = 0;
  if (!CONTROL_CHARS.test(s)) return { text: s, hits: [] };
  let count = 0;
  const text = s.replace(CONTROL_CHARS, () => {
    count++;
    return "";
  });
  return { text, hits: [{ rule: "CONTROL_CHARS", count }] };
}

/**
 * Apply one rule. `hint`/`hintRe` short-circuit without allocating, so a document that
 * mentions no provider prefix costs one `String.includes` per rule rather than a full regex
 * scan — which matters because this runs on every fenced block of every session.
 */
function applyRule(text: string, rule: RedactionRule): { text: string; count: number } {
  if (rule.hint !== undefined && !text.includes(rule.hint)) return { text, count: 0 };
  if (rule.hintRe !== undefined && !rule.hintRe.test(text)) return { text, count: 0 };

  let count = 0;
  // `String.prototype.replace` resets `lastIndex` on a global regex both before and after,
  // so the pattern literal is safe to reuse across calls.
  const out = text.replace(rule.pattern, (...args: unknown[]): string => {
    // args = [match, ...groups, offset, whole]; no rule uses named groups.
    const groups = args.slice(0, args.length - 2) as MatchGroups;
    if (rule.accept !== undefined && !rule.accept(groups)) return groups[0] ?? "";
    count++;
    return rule.replace(groups);
  });
  return { text: out, count };
}

function runRules(s: string, rules: readonly RedactionRule[]): RedactionResult {
  let text = s;
  const hits: RedactionHit[] = [];
  for (const rule of rules) {
    const r = applyRule(text, rule);
    if (r.count === 0) continue;
    text = r.text;
    const existing = hits.find((h) => h.rule === rule.rule);
    if (existing !== undefined) existing.count += r.count;
    else hits.push({ rule: rule.rule, count: r.count });
  }
  return { text, hits };
}

/**
 * Redact credential-shaped material. Returns the rewritten text plus which rule classes
 * fired and how often. `hits` carries rule names and counts only — never any secret
 * material — so it is safe to log.
 */
export function redactText(s: string): RedactionResult {
  return runRules(s, CREDENTIAL_RULES);
}

/**
 * Full hygiene pass for rendered Markdown: control-char strip → binary/image payload
 * omission → credential redaction.
 *
 * Binary omission runs *before* redaction so the credential rules never scan a
 * multi-hundred-KB base64 blob. That order cannot hide a secret: no credential shape is 512
 * contiguous base64 chars, and if one were ever embedded inside such a run the run is
 * replaced wholesale by a marker, which removes it more completely than redaction would.
 *
 * Idempotent — sanitizing an already sanitized string returns it unchanged.
 */
export function sanitizeMarkdown(s: string): RedactionResult {
  if (s === "") return { text: "", hits: [] };
  const stripped = stripControlChars(s);
  const debinaried = omitBinaryPayloads(stripped.text);
  const redacted = redactText(debinaried.text);
  if (stripped.hits.length === 0 && debinaried.hits.length === 0) {
    return { text: redacted.text, hits: redacted.hits };
  }
  return {
    text: redacted.text,
    hits: [...stripped.hits, ...debinaried.hits, ...redacted.hits],
  };
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

const FRONTMATTER_MAX_DEPTH = 4;

function mergeHits(into: RedactionHit[], from: readonly RedactionHit[]): void {
  for (const h of from) {
    const existing = into.find((x) => x.rule === h.rule);
    if (existing !== undefined) existing.count += h.count;
    else into.push({ rule: h.rule, count: h.count });
  }
}

function sanitizeValue(v: unknown, depth: number, hits: RedactionHit[]): unknown {
  if (typeof v === "string") {
    const r = sanitizeMarkdown(v);
    mergeHits(hits, r.hits);
    return r.text;
  }
  if (depth >= FRONTMATTER_MAX_DEPTH || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((el) => sanitizeValue(el, depth + 1, hits));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = sanitizeValue(val, depth + 1, hits);
  }
  return out;
}

/**
 * Sanitize every string in a frontmatter object (recursively, depth-capped), returning a
 * rewritten copy. Non-string values pass through untouched.
 *
 * Needed because the output *filename* is derived from `frontmatter.title`, so a secret in
 * a title would otherwise land in a filename on Drive — where redaction of the note body
 * would not help at all. Callers MUST use the returned object for both path construction
 * and serialization, not just serialization.
 */
export function sanitizeFrontmatter<T extends Record<string, unknown>>(
  fm: T
): { frontmatter: T; hits: RedactionHit[] } {
  const hits: RedactionHit[] = [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    out[k] = sanitizeValue(v, 0, hits);
  }
  return { frontmatter: out as T, hits };
}
