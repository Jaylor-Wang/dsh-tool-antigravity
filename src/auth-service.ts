/**
 * Unified Antigravity Authentication & Capability Lifecycle Service.
 */

import {
  createCredentialCoordinator,
  type AntigravityCredential,
  type CredentialCoordinator,
  type CredentialCoordinatorOptions,
  type CredentialStatus,
  type RevokeState
} from "./credential-coordinator.js";
import {
  createAuthStore,
  defaultAuthStorePath,
  type AuthStore,
  type AuthStoreRecord
} from "./credential-store.js";
import {
  createOAuthFlow,
  type ExchangedToken,
  type OAuthFlow,
  type OAuthFlowOptions,
  type ValidatedProject
} from "./oauth-flow.js";
import {
  createProjectDiscovery,
  type ProjectDiscovery,
  type ProjectDiscoveryOptions
} from "./project-context.js";
import {
  createQuotaService,
  type QuotaService,
  type QuotaServiceOptions,
  type QuotaSnapshot
} from "./quota-service.js";
import type { AntigravityStatusView, LoginPhase } from "./client/types.js";

export interface AntigravityAuthServiceOptions {
  storePath?: string;
  store?: AuthStore;
  credentialOptions?: Partial<CredentialCoordinatorOptions>;
  quotaOptions?: Partial<QuotaServiceOptions>;
  flowOptions?: Partial<OAuthFlowOptions>;
  projectOptions?: Partial<ProjectDiscoveryOptions>;
}

export class AntigravityAuthService {
  readonly store: AuthStore;
  readonly credentials: CredentialCoordinator;
  readonly quota: QuotaService;
  readonly flow: OAuthFlow;
  readonly projectDiscovery: ProjectDiscovery;
  riskAcknowledged = true;

  constructor(options: AntigravityAuthServiceOptions = {}) {
    const storePath = options.storePath ?? defaultAuthStorePath();
    this.store = options.store ?? createAuthStore(storePath);

    this.credentials = createCredentialCoordinator({
      ...options.credentialOptions,
      store: this.store
    });

    this.quota = createQuotaService({
      ...options.quotaOptions,
      auth: this.credentials
    });

    this.projectDiscovery = createProjectDiscovery(options.projectOptions);

    this.flow = createOAuthFlow({
      ...options.flowOptions,
      validateProject: async (accessToken, signal) => {
        const result = await this.projectDiscovery.discover(accessToken, signal);
        return result ? { projectId: result.projectId } : undefined;
      },
      commit: async (token: ExchangedToken, project: ValidatedProject) => {
        const cred: AntigravityCredential = {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAt: token.expiresAt,
          projectId: project.projectId
        };
        const record = await this.store.commit({
          refreshToken: token.refreshToken,
          projectId: project.projectId,
          email: token.email
        });
        this.credentials.replaceFromLogin(cred, record);
      }
    });
  }

  async credential(signal?: AbortSignal, options?: { forceRefresh?: boolean }) {
    return this.credentials.credential(signal, options);
  }

  async status(): Promise<AntigravityStatusView> {
    const flowStatus = this.flow.status();
    const credStatus: CredentialStatus = await this.credentials.status();

    const phase: LoginPhase =
      flowStatus.phase === "idle" && credStatus.state === "logged-in"
        ? "success"
        : (flowStatus.phase as LoginPhase);

    return {
      pluginId: "dsh-antigravity-auth",
      phase: "bootstrap",
      privateSelfUse: true,
      singleAccount: true,
      riskAcknowledgementRequired: true,
      riskAcknowledged: this.riskAcknowledged,
      login: {
        phase,
        configured: credStatus.configured,
        projectAvailable: credStatus.state === "logged-in",
        authorizationUrl: flowStatus.authorizationUrl,
        expiresAt: flowStatus.expiresAt ? new Date(flowStatus.expiresAt).toISOString() : undefined
      },
      credential: {
        state: credStatus.state,
        configured: credStatus.configured,
        expiresAt: credStatus.expiresAt,
        lastRefreshAt: credStatus.lastRefreshAt,
        errorCode: credStatus.errorCode
      },
      capabilities: [
        { id: "auth-llm", state: "available", reasonCode: "capability-ready" },
        { id: "image", state: "available", reasonCode: "capability-ready" },
        { id: "search", state: "disabled", reasonCode: "unsupported" },
        { id: "video", state: "disabled", reasonCode: "unsupported" }
      ]
    };
  }

  acknowledgeRisk(): { acknowledged: true } {
    this.riskAcknowledged = true;
    return { acknowledged: true };
  }

  async startLogin() {
    return this.flow.start();
  }

  async cancelLogin() {
    return this.flow.cancel();
  }

  async logout() {
    return this.credentials.logout();
  }

  async revoke(confirmed = true, signal?: AbortSignal): Promise<{ state: RevokeState; errorCode?: string }> {
    return this.credentials.revoke(confirmed, signal);
  }

  async usage(signal?: AbortSignal, force?: boolean): Promise<QuotaSnapshot> {
    return this.quota.refresh(signal, force);
  }
}

export function createAntigravityAuthService(
  options: AntigravityAuthServiceOptions = {}
): AntigravityAuthService {
  return new AntigravityAuthService(options);
}
