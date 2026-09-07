import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { CALENDAR_READONLY_SCOPE } from "../lib/google-calendar";
import { loadEnvironment } from "../src/load-env";

loadEnvironment();

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const PORT = Number.parseInt(process.env.GOOGLE_OAUTH_CALLBACK_PORT ?? "5555", 10);
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const ENV_FILE = path.join(process.cwd(), ".env.local");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`\n❌ ${name} 이(가) .env.local 에 없습니다.`);
    console.error("   GCP 콘솔에서 발급한 '데스크톱 앱' OAuth 클라이언트 값을 먼저 넣어주세요.\n");
    process.exit(1);
  }
  return value;
}

function buildAuthUrl(clientId: string): string {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: CALENDAR_READONLY_SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_ENDPOINT}?${query}`;
}

// 로컬 루프백으로 돌아오는 authorization code 한 번만 받아온다
function waitForAuthorizationCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404).end("not found");
        return;
      }

      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        code
          ? "<h2>인증 완료 ✅</h2><p>터미널로 돌아가세요.</p>"
          : `<h2>인증 실패 ❌</h2><p>${error ?? "unknown error"}</p>`
      );

      server.close();
      if (code) resolve(code);
      else reject(new Error(error ?? "authorization code를 받지 못했습니다"));
    });

    server.listen(PORT, () => {
      console.log(`[oauth] 콜백 대기 중: ${REDIRECT_URI}`);
    });
    server.on("error", reject);
  });
}

async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  code: string
) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  }

  return (await res.json()) as { refresh_token?: string; access_token: string };
}

function saveRefreshToken(refreshToken: string) {
  const line = `GOOGLE_OAUTH_REFRESH_TOKEN=${refreshToken}`;
  const existing = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";

  if (/^GOOGLE_OAUTH_REFRESH_TOKEN=.*$/m.test(existing)) {
    fs.writeFileSync(
      ENV_FILE,
      existing.replace(/^GOOGLE_OAUTH_REFRESH_TOKEN=.*$/m, line)
    );
    console.log("[oauth] .env.local 의 GOOGLE_OAUTH_REFRESH_TOKEN 을 갱신했습니다.");
    return;
  }

  fs.writeFileSync(
    ENV_FILE,
    `${existing}${existing.endsWith("\n") || existing === "" ? "" : "\n"}${line}\n`
  );
  console.log("[oauth] .env.local 에 GOOGLE_OAUTH_REFRESH_TOKEN 을 저장했습니다.");
}

async function main() {
  const clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");

  console.log("\n아래 URL을 브라우저에서 열고 ym5373@gachon.ac.kr 계정으로 동의해주세요:\n");
  console.log(buildAuthUrl(clientId));
  console.log("");

  const code = await waitForAuthorizationCode();
  const tokens = await exchangeCodeForTokens(clientId, clientSecret, code);

  if (!tokens.refresh_token) {
    throw new Error(
      "refresh_token이 응답에 없습니다. 기존 동의를 해제(https://myaccount.google.com/permissions)한 뒤 다시 시도해주세요."
    );
  }

  saveRefreshToken(tokens.refresh_token);
  console.log("\n✅ 구글 캘린더 연동 준비 완료\n");
}

main().catch((error) => {
  console.error("[oauth] 실패:", error);
  process.exit(1);
});
