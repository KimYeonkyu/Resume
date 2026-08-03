import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { SecurityConfiguration } from "./security";
import { validateSecurityConfiguration } from "./security";

const execFileAsync = promisify(execFile);

const DEFAULT_KEYCHAIN_SERVICES = {
  passwordVerifier: "com.jinkim.portfolio.password-verifier",
  passwordPepper: "com.jinkim.portfolio.password-pepper",
  sessionSecret: "com.jinkim.portfolio.session-secret",
} as const;

export interface RuntimeSettings {
  bindHost: string;
  canonicalOrigin: string;
  loginLimit: number;
  loginMaxKeys: number;
  loginWindowMs: number;
  port: number;
  protectedMediaRoot: string;
  publicRoot: string;
  repositoryRoot: string;
  secrets: SecurityConfiguration;
  sessionTtlSeconds: number;
}

export type KeychainReader = (account: string, service: string) => Promise<string>;

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerSetting(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = environment[name];
  if (value === undefined || value === "") return fallback;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is outside the supported range`);
  }
  return parsed;
}

function keychainLabel(value: string | undefined, fallback: string, name: string): string {
  const selected = value || fallback;
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(selected)) {
    throw new Error(`${name} is not a safe Keychain service label`);
  }
  return selected;
}

async function readMacOSKeychainSecret(account: string, service: string): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("Production Keychain secret loading requires macOS");
  }
  const { stdout } = await execFileAsync(
    "/usr/bin/security",
    ["find-generic-password", "-a", account, "-s", service, "-w"],
    { encoding: "utf8", maxBuffer: 2_048, timeout: 5_000, windowsHide: true },
  );
  const value = stdout.replace(/\r?\n$/u, "");
  if (!value || value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new Error(`Keychain entry ${service} is empty or malformed`);
  }
  return value;
}

export async function loadRuntimeSettings(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  keychainReader?: KeychainReader;
} = {}): Promise<RuntimeSettings> {
  const environment = options.env ?? process.env;
  const repositoryRoot = path.resolve(options.cwd ?? process.cwd());
  const protectedMediaRoot = required(environment, "PORTFOLIO_PROTECTED_MEDIA_ROOT");
  if (!path.isAbsolute(protectedMediaRoot)) {
    throw new Error("PORTFOLIO_PROTECTED_MEDIA_ROOT must be an absolute external path");
  }

  const source = environment.PORTFOLIO_SECRET_SOURCE ?? "keychain";
  let secrets: SecurityConfiguration;
  if (source === "environment") {
    if (environment.NODE_ENV === "production") {
      throw new Error("Production secrets must come from macOS Keychain, not environment values");
    }
    secrets = {
      passwordPepper: required(environment, "PORTFOLIO_PASSWORD_PEPPER"),
      passwordVerifier: required(environment, "PORTFOLIO_PASSWORD_VERIFIER"),
      sessionSecret: required(environment, "SESSION_SECRET"),
    };
  } else if (source === "keychain") {
    const account = required(environment, "PORTFOLIO_KEYCHAIN_ACCOUNT");
    if (!/^[^\u0000-\u001f]{1,128}$/u.test(account)) {
      throw new Error("PORTFOLIO_KEYCHAIN_ACCOUNT is malformed");
    }
    const services = {
      passwordVerifier: keychainLabel(
        environment.PORTFOLIO_KEYCHAIN_PASSWORD_VERIFIER_SERVICE,
        DEFAULT_KEYCHAIN_SERVICES.passwordVerifier,
        "PORTFOLIO_KEYCHAIN_PASSWORD_VERIFIER_SERVICE",
      ),
      passwordPepper: keychainLabel(
        environment.PORTFOLIO_KEYCHAIN_PASSWORD_PEPPER_SERVICE,
        DEFAULT_KEYCHAIN_SERVICES.passwordPepper,
        "PORTFOLIO_KEYCHAIN_PASSWORD_PEPPER_SERVICE",
      ),
      sessionSecret: keychainLabel(
        environment.PORTFOLIO_KEYCHAIN_SESSION_SECRET_SERVICE,
        DEFAULT_KEYCHAIN_SERVICES.sessionSecret,
        "PORTFOLIO_KEYCHAIN_SESSION_SECRET_SERVICE",
      ),
    };
    const reader = options.keychainReader ?? readMacOSKeychainSecret;
    const [passwordVerifier, passwordPepper, sessionSecret] = await Promise.all([
      reader(account, services.passwordVerifier),
      reader(account, services.passwordPepper),
      reader(account, services.sessionSecret),
    ]);
    secrets = { passwordVerifier, passwordPepper, sessionSecret };
  } else {
    throw new Error("PORTFOLIO_SECRET_SOURCE must be keychain or environment");
  }
  validateSecurityConfiguration(secrets);

  return {
    bindHost: environment.PORTFOLIO_BIND_HOST ?? "127.0.0.1",
    canonicalOrigin: required(environment, "PORTFOLIO_CANONICAL_ORIGIN"),
    loginLimit: integerSetting(environment, "PORTFOLIO_LOGIN_LIMIT", 10, 1, 100),
    loginMaxKeys: integerSetting(environment, "PORTFOLIO_LOGIN_MAX_KEYS", 4_096, 16, 100_000),
    loginWindowMs: integerSetting(
      environment,
      "PORTFOLIO_LOGIN_WINDOW_MS",
      60_000,
      1_000,
      60 * 60 * 1_000,
    ),
    port: integerSetting(environment, "PORTFOLIO_PORT", 8_794, 1, 65_535),
    protectedMediaRoot,
    publicRoot: path.resolve(repositoryRoot, environment.PORTFOLIO_PUBLIC_ROOT ?? "dist"),
    repositoryRoot,
    secrets,
    sessionTtlSeconds: integerSetting(
      environment,
      "PORTFOLIO_SESSION_TTL_SECONDS",
      7_200,
      60,
      8 * 60 * 60,
    ),
  };
}
