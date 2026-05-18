import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AuthConfig } from "../config/service-config.js";
import { ConfigError, GitHubApiError } from "../errors.js";

export interface GitHubAuthProvider {
  getAuthorizationHeader(): Promise<string | null>;
}

export function createGitHubAuthProvider(
  config: AuthConfig,
  apiBaseUrl: string,
  apiVersion: string,
  fetchImpl: typeof fetch = fetch
): GitHubAuthProvider {
  if (config.type === "app") {
    return new GitHubAppAuthProvider(config, apiBaseUrl, apiVersion, fetchImpl);
  }
  return new TokenAuthProvider(config.token);
}

class TokenAuthProvider implements GitHubAuthProvider {
  constructor(private readonly token: string | null) {}

  async getAuthorizationHeader(): Promise<string | null> {
    return this.token ? `Bearer ${this.token}` : null;
  }
}

class GitHubAppAuthProvider implements GitHubAuthProvider {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: Extract<AuthConfig, { type: "app" }>,
    private readonly apiBaseUrl: string,
    private readonly apiVersion: string,
    private readonly fetchImpl: typeof fetch
  ) {}

  async getAuthorizationHeader(): Promise<string | null> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - 60_000 > now) {
      return `Bearer ${this.cached.token}`;
    }

    const jwt = await this.createJwt();
    const url = `${this.apiBaseUrl}/app/installations/${encodeURIComponent(
      this.config.installationId
    )}/access_tokens`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": this.apiVersion
      }
    });

    const body = await readJsonSafely(response);
    if (!response.ok) {
      throw new GitHubApiError("Unable to create GitHub App installation token", response.status, body);
    }

    const token = typeof body?.token === "string" ? body.token : null;
    const expiresAtText = typeof body?.expires_at === "string" ? body.expires_at : null;
    if (!token || !expiresAtText) {
      throw new GitHubApiError("GitHub App installation token response was malformed", response.status, body);
    }

    this.cached = {
      token,
      expiresAt: Date.parse(expiresAtText)
    };
    return `Bearer ${token}`;
  }

  private async createJwt(): Promise<string> {
    const privateKey = await this.readPrivateKey();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
    const payload = base64UrlJson({
      iat: nowSeconds - 60,
      exp: nowSeconds + 540,
      iss: this.config.appId
    });
    const signingInput = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(privateKey).toString("base64url");
    return `${signingInput}.${signature}`;
  }

  private async readPrivateKey(): Promise<string> {
    if (this.config.privateKey) {
      return this.config.privateKey.replace(/\\n/g, "\n");
    }
    if (this.config.privateKeyPath) {
      return readFile(this.config.privateKeyPath, "utf8");
    }
    throw new ConfigError("GitHub App auth requires tracker.auth.private_key or private_key_path");
  }
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function readJsonSafely(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
