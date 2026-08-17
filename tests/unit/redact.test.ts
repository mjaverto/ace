// tests/unit/redact.test.ts — unit tests for credential redaction and content hygiene
//
// Every secret in this file is SYNTHETIC: invented for the test, never copied from a real
// transcript. Each one is also assembled by concatenation so the full credential shape
// never appears as one contiguous literal in the repo — otherwise this file would itself
// trip secret scanners and, worse, look like a leak to a future reader.

import { describe, it, expect } from "vitest";
import {
  sanitizeMarkdown,
  redactText,
  omitBinaryPayloads,
  stripControlChars,
  sanitizeFrontmatter,
  shannonEntropy,
  BASE64_MIN_RUN,
  IMAGE_OMITTED,
  BINARY_OMITTED,
} from "../../src/core/redact.js";
import { fence, detailsBlock, toolCallBlock, toolOutputBlock, sectionForUnknown } from "../../src/markdown.js";

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

const MARK = "\u2039redacted:";

/** 87 random-looking base64url chars — the shape of an `sk-ant-api03-` body. */
const ANT_BODY = "Rt7vQm2LpZ9xKd4WnB6yTc1JhF8sAe0gUiOo3rXlM5PwYbNvQzHkDjSfGa2tCuRe7L9mX4pB1nZ8kJ3vTyW6dQ";
const ANTHROPIC_KEY = "sk-ant-" + "api03-" + ANT_BODY;
const ANTHROPIC_OAT = "sk-ant-" + "oat01-" + ANT_BODY;
const OPENAI_KEY = "sk-" + "proj-" + "9mQz4RtVbN7yKpL2wXcH8sDf1gTaEo0UiZ3rMlP6wYbQvSkJhDn";
const OPENROUTER_KEY = "sk-or-" + "v1-" + "3f9a2c7e4b18d05f6a3c9e2b7d148f05a6c3e9b2d7f148a05c6e3b9d2f7a148c0";
const GITHUB_PAT = "github" + "_pat_" + "11ABCQZY0" + "Rt7vQm2LpZ9xKd4WnB6yTc1JhF8sAe0gUiOo3rXlM5PwYbNvQzHkDjSf2tCuRe";
const GITHUB_CLASSIC = "ghp" + "_" + "Rt7vQm2LpZ9xKd4WnB6yTc1JhF8sAe0gUiOo";
const SLACK_TOKEN = "xoxb" + "-" + "2947183650472-3861049275013-" + "Kq9WzR2mVt7YpL4jN8bXcH5s";
const AWS_AKID = "AKIA" + "3QZY7VWN2KRTLPD5";
// Split like the constants above so no contiguous 40-char AWS-secret-shaped
// literal exists in the blob — GitHub push protection flags one even when it is
// synthetic. The runtime value is unchanged, so the entropy gate still sees a
// realistic key.
const AWS_SECRET = "wJ9r/K7bNq2LpZ9x" + "Kd4WnB6yTc1JhF8s" + "Ae0gUiO3";
const GOOGLE_API_KEY = "AIza" + "SyD9r7K2bNq4LpZ9xKd4WnB6yTc1JhF8sAe";
const GOOGLE_CLIENT_SECRET = "GOCSPX" + "-" + "9r7K2bNq4LpZ9xKd4WnB6yTc1Jh";
const GOOGLE_REFRESH = "1//0" + "9r7K2bNq4LpZ9xKd4WnB6yTc1JhF8sAe0gUiOo3rXlM5Pw";
const HF_TOKEN = "hf" + "_" + "QZY7VWN2KRTLPD59mQz4RtVbN7yKpL2wXc";

/** Real-shaped HS256 JWT: decodable header, synthetic payload, garbage signature. */
const JWT =
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url") +
  "." +
  Buffer.from(JSON.stringify({ sub: "1234567890", name: "Synthetic Tester", iat: 1516239022 })).toString("base64url") +
  "." +
  "Kq9WzR2mVt7YpL4jN8bXcH5sDf1gTaEo0UiZ3rMlP6w";

const PEM_BODY = [
  "MIIEpAIBAAKCAQEAy8Qm2LpZ9xKd4WnB6yTc1JhF8sAe0gUiOo3rXlM5PwYbNvQz",
  "HkDjSfGa2tCuRe7L9mX4pB1nZ8kJ3vTyW6dQRt7vQm2LpZ9xKd4WnB6yTc1JhF8s",
  "Ae0gUiOo3rXlM5PwYbNvQzHkDjSfGa2tCuRe7L9mX4pB1nZ8kJ3vTyW6dQRt7vQm",
].join("\n");
const PEM = `-----BEGIN OPENSSH PRIVATE KEY-----\n${PEM_BODY}\n-----END OPENSSH PRIVATE KEY-----`;

/**
 * Deterministic high-entropy base64 of the requested length. Written as a real byte
 * sequence rather than a repeated pattern, because a low-entropy run is (correctly)
 * ignored by the payload rules.
 */
function b64(len: number): string {
  const bytes = new Uint8Array(Math.ceil(len * 0.75) + 3);
  let x = 0x2545f491;
  for (let i = 0; i < bytes.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    bytes[i] = (x >>> 3) & 0xff;
  }
  return Buffer.from(bytes).toString("base64").replace(/=+$/, "").slice(0, len);
}

// ---------------------------------------------------------------------------
// Credential classes
// ---------------------------------------------------------------------------

describe("redactText — credential classes", () => {
  it("redacts an Anthropic api03 key and keeps the public class prefix", () => {
    const r = redactText(`ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`);
    expect(r.text).toBe(`ANTHROPIC_API_KEY=sk-ant-api03-${MARK}ANTHROPIC_API_KEY\u203a`);
    expect(r.text).not.toContain(ANT_BODY);
    expect(r.hits).toEqual([{ rule: "ANTHROPIC_API_KEY", count: 1 }]);
  });

  it("redacts an Anthropic oat01 token", () => {
    const r = redactText(ANTHROPIC_OAT);
    expect(r.text).not.toContain(ANT_BODY);
    expect(r.hits).toEqual([{ rule: "ANTHROPIC_API_KEY", count: 1 }]);
  });

  it("redacts an OpenAI project key", () => {
    const r = redactText(`OPENAI_API_KEY=${OPENAI_KEY}`);
    expect(r.text).toContain(`sk-proj-${MARK}OPENAI_API_KEY`);
    expect(r.text).not.toContain(OPENAI_KEY);
  });

  it("redacts an OpenRouter key", () => {
    const r = redactText(`key: ${OPENROUTER_KEY}`);
    expect(r.hits).toEqual([{ rule: "OPENROUTER_API_KEY", count: 1 }]);
    expect(r.text).not.toContain(OPENROUTER_KEY);
  });

  it("redacts a GitHub fine-grained PAT", () => {
    const r = redactText(`use ${GITHUB_PAT} to push`);
    expect(r.text).toBe(`use github_pat_${MARK}GITHUB_PAT\u203a to push`);
    expect(r.hits).toEqual([{ rule: "GITHUB_PAT", count: 1 }]);
  });

  it("redacts a classic GitHub token", () => {
    const r = redactText(`GH_TOKEN=${GITHUB_CLASSIC}`);
    expect(r.text).toContain(`ghp_${MARK}GITHUB_TOKEN`);
    expect(r.text).not.toContain(GITHUB_CLASSIC);
  });

  it("redacts a Slack bot token", () => {
    const r = redactText(`SLACK_BOT_TOKEN=${SLACK_TOKEN}`);
    expect(r.text).toContain(`xoxb-${MARK}SLACK_TOKEN`);
    expect(r.text).not.toContain(SLACK_TOKEN);
  });

  it("redacts an AWS access key id, preserving the 4-char class prefix", () => {
    const r = redactText(`AWS_ACCESS_KEY_ID=${AWS_AKID}`);
    expect(r.text).toBe(`AWS_ACCESS_KEY_ID=AKIA${MARK}AWS_ACCESS_KEY_ID\u203a`);
    expect(r.text).not.toContain("3QZY7VWN2KRTLPD5");
  });

  it("redacts a 40-char AWS secret access key in a keyed context", () => {
    const r = redactText(`aws_secret_access_key = "${AWS_SECRET}"`);
    expect(r.text).toBe(`aws_secret_access_key = "${MARK}AWS_SECRET_ACCESS_KEY\u203a"`);
    expect(r.hits).toEqual([{ rule: "AWS_SECRET_ACCESS_KEY", count: 1 }]);
  });

  it("redacts a Google API key", () => {
    const r = redactText(`GOOGLE_MAPS=${GOOGLE_API_KEY}`);
    expect(r.text).toContain(`AIza${MARK}GOOGLE_API_KEY`);
    expect(r.text).not.toContain(GOOGLE_API_KEY);
  });

  it("redacts a Google OAuth client secret and refresh token", () => {
    const r = redactText(`GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}\nGOOGLE_REFRESH_TOKEN=${GOOGLE_REFRESH}`);
    expect(r.text).not.toContain(GOOGLE_CLIENT_SECRET);
    expect(r.text).not.toContain(GOOGLE_REFRESH);
    expect(r.hits.map((h) => h.rule).sort()).toEqual([
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_OAUTH_REFRESH_TOKEN",
    ]);
  });

  it("redacts a HuggingFace token", () => {
    const r = redactText(`HF_TOKEN=${HF_TOKEN}`);
    expect(r.text).toContain(`hf_${MARK}HUGGINGFACE_TOKEN`);
  });

  it("redacts an Authorization: Bearer header once, not twice", () => {
    const r = redactText(`curl -H "Authorization: Bearer ${OPENROUTER_KEY}" https://api/x`);
    expect(r.text).toBe(`curl -H "Authorization: Bearer ${MARK}AUTHORIZATION_HEADER\u203a" https://api/x`);
    expect(r.hits).toEqual([{ rule: "AUTHORIZATION_HEADER", count: 1 }]);
  });

  it("redacts an x-api-key header", () => {
    const r = redactText(`-H 'x-api-key: ${ANTHROPIC_KEY}'`);
    expect(r.text).not.toContain(ANT_BODY);
    expect(r.hits).toEqual([{ rule: "SECRET_HEADER", count: 1 }]);
  });

  it("redacts a password embedded in a database URL, keeping the username", () => {
    const r = redactText("DATABASE_URL=postgres://appuser:Tr0ub4dor3xyz@db.internal:5432/prod");
    expect(r.text).toBe(`DATABASE_URL=postgres://appuser:${MARK}URL_PASSWORD\u203a@db.internal:5432/prod`);
    expect(r.text).not.toContain("Tr0ub4dor3xyz");
  });

  it("redacts .env-style secret assignments and names the key in the marker", () => {
    const r = redactText(
      [
        "POSTGRES_PASSWORD=Hn7wQ2mLpZ9xKd4W",
        "SESSION_SECRET=9r7K2bNq4LpZ9xKd4WnB6yTc",
        // Split: 40 base64-ish chars after `=` reads as an AWS secret key to
        // GitHub push protection. Runtime value unchanged.
        "CLOUDFLARE_API_TOKEN=" + "Kq9WzR2mVt7YpL4jN8bXcH5s" + "Df1gTaEo0UiZ3rMl",
        "APP_JWT_SECRET=Vt7YpL4jN8bXcH5sDf1gTaEo",
      ].join("\n")
    );
    expect(r.text).toContain(`POSTGRES_PASSWORD=${MARK}POSTGRES_PASSWORD\u203a`);
    expect(r.text).toContain(`SESSION_SECRET=${MARK}SESSION_SECRET\u203a`);
    expect(r.text).toContain(`CLOUDFLARE_API_TOKEN=${MARK}CLOUDFLARE_API_TOKEN\u203a`);
    expect(r.text).toContain(`APP_JWT_SECRET=${MARK}APP_JWT_SECRET\u203a`);
    expect(r.hits).toEqual([{ rule: "SECRET_ASSIGNMENT", count: 4 }]);
  });

  it("leaves non-secret lines in an env dump untouched", () => {
    const r = redactText("PUBLIC_BASE_URL=https://example.com\nNODE_ENV=production");
    expect(r.text).toBe("PUBLIC_BASE_URL=https://example.com\nNODE_ENV=production");
    expect(r.hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

describe("redactText — JWT", () => {
  it("redacts a JWT whose header decodes to JSON with alg/typ", () => {
    const r = redactText(`Cookie: session=${JWT}`);
    expect(r.text).toBe(`Cookie: session=eyJ${MARK}JWT\u203a`);
    expect(r.hits).toEqual([{ rule: "JWT", count: 1 }]);
  });

  it("leaves an eyJ-prefixed string alone when the header is not decodable JWT JSON", () => {
    // `eyJ` only means the base64 starts with `{"`. This one decodes to {"note":…}, which
    // declares neither alg nor typ, so it is not a token.
    const notAToken =
      Buffer.from(JSON.stringify({ note: "just some json data here" })).toString("base64url") +
      ".QUJDREVGR0hJSg." +
      "S0xNTk9QUVJTVA";
    expect(notAToken.startsWith("eyJ")).toBe(true);
    const r = redactText(notAToken);
    expect(r.text).toBe(notAToken);
    expect(r.hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PEM
// ---------------------------------------------------------------------------

describe("redactText — private key blocks", () => {
  it("redacts the whole PEM body while keeping the BEGIN/END envelope", () => {
    const r = redactText(`found this:\n${PEM}\nand text after it`);
    expect(r.text).not.toContain(PEM_BODY);
    expect(r.text).not.toContain("MIIEpAIBAAKCAQEA");
    expect(r.text).toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(r.text).toContain("-----END OPENSSH PRIVATE KEY-----");
    expect(r.text).toContain(`${MARK}PRIVATE_KEY\u203a`);
    expect(r.text).toContain("and text after it");
    expect(r.hits).toEqual([{ rule: "PRIVATE_KEY_BLOCK", count: 1 }]);
  });

  it("redacts a truncated key body without swallowing the rest of the document", () => {
    const r = redactText(`-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n\n… [truncated 900 bytes]\n\nnext section`);
    expect(r.text).not.toContain("MIIEpAIBAAKCAQEA");
    expect(r.text).toContain("next section");
    expect(r.hits).toEqual([{ rule: "PRIVATE_KEY_BODY_UNTERMINATED", count: 1 }]);
  });

  it("redacts a JSON-escaped service-account private key", () => {
    const r = redactText(
      '{"private_key":"-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\\n-----END PRIVATE KEY-----\\n"}'
    );
    expect(r.text).not.toContain("MIIEvQIBADANBgkqhkiG");
    expect(r.text).toContain(`${MARK}PRIVATE_KEY\u203a`);
  });
});

// ---------------------------------------------------------------------------
// False-positive guards
// ---------------------------------------------------------------------------

describe("redactText — false-positive guards", () => {
  const untouched: ReadonlyArray<readonly [string, string]> = [
    ["masked placeholder key", "ANTHROPIC_API_KEY=sk-ant-api03-" + "x".repeat(95)],
    ["documentation placeholder", "ANTHROPIC_API_KEY=your-api-key-here"],
    ["AWS documentation example", "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"],
    ["hand-typed sequential fixture", "aws configure set " + "AKIA" + "ABCDEFGHIJKLMNOP"],
    ["shell variable reference", "export ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"],
    ["GitHub Actions secret reference", "GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}"],
    ["python type annotation", "    password: str"],
    ["pydantic field declaration", "    api_key: SecretStr = Field(default=None)"],
    ["os.environ lookup", 'SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]'],
    ["typescript property type", "  apiKey: string;"],
    ["zod schema", "  token: z.string().min(1)"],
    ["dynamo sort key column name", "SORT_KEY=created_at"],
    ["primary key column name", "PRIMARY_KEY=id"],
    ["sha256 digest", "sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
    ["git commit sha", "commit 8f4e2a1c9d7b3f6e5a8c2d1b4f7e9a3c6d5b8f2e"],
    ["uuid", "id: 58726b2b-4f3a-4c1d-9e2f-7a6b5c4d3e2f"],
    ["ordinary shell command", "ls -la"],
    // The following are real shapes taken from a 1.13 GB audit of local transcripts, where
    // the key name alone was a bad signal because agent sessions are mostly source code.
    ["react hook assigned to a token variable", "  const accessToken = useCallback"],
    ["fetch credentials mode", "  fetch(url, { credentials: 'include' })"],
    ["fetch credentials same-origin", "credentials: 'same-origin'"],
    ["localStorage key name constant", "const STORAGE_KEY = 'shapekit.builtInCategories'"],
    ["localStorage token key name", "const ACCESS_TOKEN_KEY = 'access_token'"],
    ["go error value", "var errNoToken = errors"],
    ["vitest mock of a hash function", "  hashPassword: vi.fn"],
    ["kubernetes boolean field", "  automountServiceAccountToken: false"],
    ["cors response header", "access-control-allow-credentials: true"],
    ["back-compat prose (PAT must not match inside a word)", "# Back-compat: accepted"],
    ["libpq option name (PAT must not match inside a word)", "use 'uselibpqcompat=disable'"],
    ["camelCase timestamp field (PAT must not match)", "  signedUpAt: timestamp"],
  ];

  for (const [label, input] of untouched) {
    it(`leaves ${label} unchanged`, () => {
      const r = sanitizeMarkdown(input);
      expect(r.text).toBe(input);
      expect(r.hits).toEqual([]);
    });
  }

  it("still redacts a digit-free password, because the password family is exempt", () => {
    // Human-chosen passwords are often digit-free words, and a leaked password is the
    // highest-harm case, so PASSWORD/PASSWD/PASSPHRASE keys skip the code-or-word gate.
    const r = redactText("POSTGRES_PASSWORD=postgres");
    expect(r.text).toBe(`POSTGRES_PASSWORD=${MARK}POSTGRES_PASSWORD\u203a`);
  });

  it("redacts an opaque digit-bearing value under a non-password key", () => {
    const r = redactText("SESSION_SECRET=9r7K2bNq4LpZ9xKd4WnB6yTc");
    expect(r.text).toBe(`SESSION_SECRET=${MARK}SESSION_SECRET\u203a`);
  });
});

// ---------------------------------------------------------------------------
// Truncated key fragments (the filename leak vector)
// ---------------------------------------------------------------------------

describe("redactText — truncated key fragments", () => {
  // `frontmatter.title` is derived from raw first-message text and truncated mid-token by the
  // sources, and the output FILENAME is derived from the title. A fragment surviving here
  // lands in a filename on Drive, where body redaction cannot reach it. Length minimums
  // chosen from full-length keys let the 8..20 char range straight through.
  const fragments: ReadonlyArray<readonly [string, string, string]> = [
    ["anthropic", "sk-ant-api03-" + ANT_BODY.slice(0, 8), "ANTHROPIC_API_KEY"],
    ["anthropic 12", "sk-ant-api03-" + ANT_BODY.slice(0, 12), "ANTHROPIC_API_KEY"],
    ["anthropic 20", "sk-ant-api03-" + ANT_BODY.slice(0, 20), "ANTHROPIC_API_KEY"],
    ["github pat", "github" + "_pat_" + "11ABCQZY0Rt7vQm2", "GITHUB_PAT"],
    ["github classic", "ghp" + "_" + "Rt7vQm2LpZ9x", "GITHUB_TOKEN"],
    ["slack", "xoxb" + "-" + "2947183650472", "SLACK_TOKEN"],
    ["aws akid", "AKIA" + "3QZY7VWN", "AWS_ACCESS_KEY_ID"],
    ["google api key", "AIza" + "SyD9r7K2b", "GOOGLE_API_KEY"],
    ["google client secret", "GOCSPX" + "-" + "9r7K2bNq4Lp", "GOOGLE_OAUTH_CLIENT_SECRET"],
    ["stripe", "sk_test_" + "9r7K2bNq4Lp", "STRIPE_SECRET_KEY"],
  ];

  for (const [label, fragment, rule] of fragments) {
    it(`redacts a truncated ${label} fragment (${fragment.length} chars)`, () => {
      const r = redactText(`title: fix ${fragment}`);
      expect(r.text).not.toContain(fragment);
      expect(r.hits).toEqual([{ rule, count: 1 }]);
    });
  }

  it("still rejects a truncated placeholder fragment", () => {
    // The placeholder brake is what replaces the length floor, so it must survive it.
    for (const s of [
      "sk-ant-api03-xxxxxxxx",
      "sk-ant-api03-abcdefgh",
      "sk-ant-api03-12345678",
      "AKIAABCDEFGH",
      "AIzaEXAMPLE12",
      "github" + "_pat_" + "REDACTED0",
    ]) {
      const r = redactText(s);
      expect(r.text).toBe(s);
      expect(r.hits).toEqual([]);
    }
  });

  it("does not redact digit-free xox* fixtures, which lowering the floor first broke", () => {
    // 108 of these appeared in the audit corpus the moment the body minimum dropped to 8.
    // Every real Slack token is `xox?-<numeric team id>-<numeric id>-<secret>`, so the body
    // must start with a digit.
    for (const s of [
      '"access_token": "xoxp' + '-test-token"',
      '"access_token": "xoxb' + '-fake-token"',
      '"identity_token": "xoxp' + '-stub-token"',
    ]) {
      const r = redactText(s);
      expect(r.text).toBe(s);
      expect(r.hits).toEqual([]);
    }
  });

  it("does not redact AWS IAM entity unique ids, which are not credentials", () => {
    // `Authenticated as assumedRoleId AROA…` CI log lines produced 6 false positives.
    // AIDA/AROA/ANPA/ANVA/ACCA/ABIA are public identifiers; only AKIA/ASIA are keys.
    for (const s of [
      "Authenticated as assumedRoleId AROA3QZY7VWN2KRTL",
      "user id AIDA3QZY7VWN2KRTL",
      "policy id ANPA3QZY7VWN2KRTL",
    ]) {
      const r = redactText(s);
      expect(r.text).toBe(s);
      expect(r.hits).toEqual([]);
    }
  });

  it("still redacts an ASIA temporary access key", () => {
    const r = redactText("AWS_ACCESS_KEY_ID=ASIA3QZY7VWN2KRTLPD5");
    expect(r.text).toContain(`ASIA${MARK}AWS_ACCESS_KEY_ID\u203a`);
  });

  it("survives slugification without leaking, given a truncated key in a title", () => {
    // Mirrors naming.ts: strip markers to plain text, lowercase, non-alnum -> '-'.
    const title = `here is my key sk-ant-api03-${ANT_BODY.slice(0, 16)}`;
    const safe = sanitizeMarkdown(title).text;
    const slug = safe
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 55);
    expect(safe).not.toContain(ANT_BODY.slice(0, 16));
    expect(slug).not.toContain(ANT_BODY.slice(0, 16).toLowerCase());
    expect(slug).toBe("here-is-my-key-sk-ant-api03-redacted-anthropic-api-key");
  });
});

// ---------------------------------------------------------------------------
// Binary / image payloads
// ---------------------------------------------------------------------------

describe("omitBinaryPayloads", () => {
  it("replaces a JSON image data field with the image marker", () => {
    const payload = "iVBORw0KGgoAAAANSUhEUg" + b64(4000);
    const json = `{\n  "type": "image",\n  "source": {\n    "type": "base64",\n    "media_type": "image/png",\n    "data": "${payload}"\n  }\n}`;
    const r = omitBinaryPayloads(json);
    expect(r.text).toContain(`"data": "${IMAGE_OMITTED}"`);
    expect(r.text).not.toContain(payload.slice(0, 200));
    expect(r.text.length).toBeLessThan(300);
    expect(r.hits).toEqual([{ rule: "IMAGE_PAYLOAD_FIELD", count: 1 }]);
  });

  it("replaces a base64 data: URI with the image marker, keeping the mime type", () => {
    const r = omitBinaryPayloads(`![shot](data:image/png;base64,${b64(3000)})`);
    expect(r.text).toBe(`![shot](data:image/png;base64,${IMAGE_OMITTED})`);
    expect(r.hits).toEqual([{ rule: "DATA_URI_PAYLOAD", count: 1 }]);
  });

  it("replaces a contextless long base64 run with the binary marker", () => {
    const r = omitBinaryPayloads(`blob: ${b64(2000)} end`);
    expect(r.text).toBe(`blob: ${BINARY_OMITTED} end`);
    expect(r.hits).toEqual([{ rule: "BINARY_PAYLOAD", count: 1 }]);
  });

  it("leaves a base64 run shorter than the threshold alone", () => {
    const input = `short: ${b64(BASE64_MIN_RUN - 100)} end`;
    const r = omitBinaryPayloads(input);
    expect(r.text).toBe(input);
    expect(r.hits).toEqual([]);
  });

  it("leaves long minified JavaScript alone", () => {
    const minified =
      "function a(b,c){var d=b.length,e=c.length;for(var f=0;f<d;f++){if(b[f]!==c[f%e]){return!1}}return!0}".repeat(12);
    expect(minified.length).toBeGreaterThan(BASE64_MIN_RUN);
    const r = omitBinaryPayloads(minified);
    expect(r.text).toBe(minified);
    expect(r.hits).toEqual([]);
  });

  it("leaves a long single-case hex string alone", () => {
    // 800 chars of hex: over the length threshold, but single-case with no `+`/`/`, so it
    // is a digest rather than an encoded payload.
    const hexRun = "a3f9c1d7e2b48056".repeat(50);
    expect(hexRun.length).toBeGreaterThan(BASE64_MIN_RUN);
    const r = omitBinaryPayloads(hexRun);
    expect(r.text).toBe(hexRun);
    expect(r.hits).toEqual([]);
  });

  it("leaves a long snake_case identifier run alone", () => {
    const identRun = "very_long_snake_case_identifier_".repeat(30);
    const r = omitBinaryPayloads(identRun);
    expect(r.text).toBe(identRun);
    expect(r.hits).toEqual([]);
  });

  it("scores real base64 far above the entropy floor and a masked run far below", () => {
    expect(shannonEntropy(b64(2000))).toBeGreaterThan(5);
    expect(shannonEntropy("x".repeat(2000))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Control characters
// ---------------------------------------------------------------------------

describe("stripControlChars", () => {
  it("strips NUL, BEL and ESC while preserving tab and newline", () => {
    const r = stripControlChars("before\u0000after\ttab\nnewline\u0007bell\u001b[31m");
    expect(r.text).toBe("beforeafter\ttab\nnewlinebell[31m");
    expect(r.text).not.toContain("\u0000");
    expect(r.text).toContain("\t");
    expect(r.text).toContain("\n");
    expect(r.hits).toEqual([{ rule: "CONTROL_CHARS", count: 3 }]);
  });

  it("is a no-op for clean text", () => {
    const clean = "line one\n\tindented line\n";
    const r = stripControlChars(clean);
    expect(r.text).toBe(clean);
    expect(r.hits).toEqual([]);
  });

  it("strips NUL through the full sanitize pipeline", () => {
    const r = sanitizeMarkdown("a\u0000b");
    expect(r.text).toBe("ab");
    expect(r.hits).toEqual([{ rule: "CONTROL_CHARS", count: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// hits reporting
// ---------------------------------------------------------------------------

describe("sanitizeMarkdown — hits reporting", () => {
  const doc = [
    `ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`,
    `AWS_ACCESS_KEY_ID=${AWS_AKID}`,
    `Authorization: Bearer ${OPENROUTER_KEY}`,
    PEM,
    "clean\u0000line",
  ].join("\n");

  it("reports every rule class that fired, with counts", () => {
    const r = sanitizeMarkdown(doc);
    expect(r.hits.map((h) => h.rule).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "AUTHORIZATION_HEADER",
      "AWS_ACCESS_KEY_ID",
      "CONTROL_CHARS",
      "PRIVATE_KEY_BLOCK",
    ]);
    for (const h of r.hits) expect(h.count).toBeGreaterThan(0);
  });

  it("never leaks secret material through hits", () => {
    const serialized = JSON.stringify(sanitizeMarkdown(doc).hits);
    for (const secret of [ANT_BODY, AWS_AKID, OPENROUTER_KEY, PEM_BODY]) {
      expect(serialized).not.toContain(secret.slice(0, 12));
    }
    // hits carry only a rule name and a count — nothing else.
    for (const h of sanitizeMarkdown(doc).hits) {
      expect(Object.keys(h).sort()).toEqual(["count", "rule"]);
    }
  });

  it("counts repeated occurrences of the same rule once, aggregated", () => {
    const r = redactText(`${ANTHROPIC_KEY}\n${ANTHROPIC_OAT}`);
    expect(r.hits).toEqual([{ rule: "ANTHROPIC_API_KEY", count: 2 }]);
  });

  it("is idempotent — a second pass changes nothing and reports nothing", () => {
    const once = sanitizeMarkdown(doc);
    const twice = sanitizeMarkdown(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

describe("sanitizeFrontmatter", () => {
  it("redacts string values, recurses into nested objects, and leaves other types alone", () => {
    const r = sanitizeFrontmatter({
      source: "claude",
      title: `rotate ${GITHUB_CLASSIC} everywhere`,
      messageCount: 12,
      aceSchema: 1,
      x_claude: { note: "db=postgres://u:Sup3rSecretPw@h/x" },
      tags: [`key ${GOOGLE_API_KEY}`, "plain"],
    });
    expect(r.frontmatter.title).not.toContain(GITHUB_CLASSIC);
    expect(r.frontmatter.title).toContain(`${MARK}GITHUB_TOKEN\u203a`);
    expect(r.frontmatter.source).toBe("claude");
    expect(r.frontmatter.messageCount).toBe(12);
    expect(r.frontmatter.aceSchema).toBe(1);
    expect(r.frontmatter.x_claude.note).not.toContain("Sup3rSecretPw");
    expect(r.frontmatter.tags[0]).not.toContain(GOOGLE_API_KEY);
    expect(r.frontmatter.tags[1]).toBe("plain");
    expect(r.hits.map((h) => h.rule).sort()).toEqual([
      "GITHUB_TOKEN",
      "GOOGLE_API_KEY",
      "URL_CREDENTIALS",
    ]);
  });

  it("returns frontmatter unchanged when nothing matches", () => {
    const fm = { source: "codex", title: "restore qa tester agent files", messageCount: 3 };
    const r = sanitizeFrontmatter(fm);
    expect(r.frontmatter).toEqual(fm);
    expect(r.hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// markdown.ts wiring
// ---------------------------------------------------------------------------

describe("markdown.ts sanitizing choke point", () => {
  it("keeps benign fence output byte-identical", () => {
    expect(fence("bash", "ls -la")).toBe("```bash\nls -la\n```\n\n");
    expect(fence("json", '{\n  "key": "value"\n}')).toBe('```json\n{\n  "key": "value"\n}\n```\n\n');
    expect(detailsBlock("thinking", "I need to think.")).toBe(
      "<details><summary>thinking</summary>\n\nI need to think.\n\n</details>\n\n"
    );
  });

  it("redacts tool input via toolCallBlock", () => {
    const input = JSON.stringify({ command: `curl -H "x-api-key: ${ANTHROPIC_KEY}" https://api.anthropic.com` }, null, 2);
    const out = toolCallBlock({ name: "Bash", input });
    expect(out).not.toContain(ANT_BODY);
    expect(out).toContain(MARK);
  });

  it("redacts tool output via toolOutputBlock, keeping non-secret lines", () => {
    const out = toolOutputBlock({
      output: `POSTGRES_PASSWORD=Hn7wQ2mLpZ9xKd4W\nANTHROPIC_API_KEY=${ANTHROPIC_KEY}\nPUBLIC_BASE_URL=https://example.com`,
    });
    expect(out).not.toContain(ANT_BODY);
    expect(out).not.toContain("Hn7wQ2mLpZ9xKd4W");
    expect(out).toContain("PUBLIC_BASE_URL=https://example.com");
  });

  it("redacts assistant thinking via detailsBlock", () => {
    const out = detailsBlock("thinking", `I will use ${ANTHROPIC_KEY} for this call.`);
    expect(out).not.toContain(ANT_BODY);
    expect(out).toContain(`${MARK}ANTHROPIC_API_KEY\u203a`);
  });

  it("collapses a raw image content block surfaced by sectionForUnknown", () => {
    const payload = b64(120000);
    const block = { type: "image", source: { type: "base64", media_type: "image/png", data: payload } };
    const out = sectionForUnknown("unknown block: image", block);
    expect(out).toContain(IMAGE_OMITTED);
    expect(out).not.toContain(payload.slice(0, 300));
    expect(out.length).toBeLessThan(500);
  });

  it("strips NUL from fenced bodies so grep does not treat the note as binary", () => {
    const out = fence("", "line1\u0000line2\tkept");
    expect(out).not.toContain("\u0000");
    expect(out).toContain("\t");
  });
});
