// Native lineage for deprecated synchronous SDK compatibility and incognito-only projection.

import type { SessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import { captureSessionEntryMetadataRead } from "../config/sessions/session-entry-source-authority.js";
import { createExistingAgentSessionStoreTargetResolver } from "../config/sessions/targets-discovery.native.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { createOpenClawAgentDatabasePathMatcher } from "../state/openclaw-agent-db.paths.js";
import { resolveSessionStoreIdentity, selectStoredSessionLineage } from "./session-store-key.js";
import {
  resolveGatewaySessionStoreCandidates,
  type GatewaySessionStoreDiscoveryCache,
} from "./session-utils-store-candidates.js";
import {
  resolveNativeGatewaySessionStoreTargetWithStore,
  type GatewaySessionStoreLookupParams,
} from "./session-utils-store-lookup.js";
import { readGatewaySessionStore } from "./session-utils-store-read.js";

/** Stored-address joins share discovery without passing selected keys through request aliases. */
export function createGatewaySessionLineageReader(cfg: OpenClawConfig) {
  const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
  const resolveExistingTargets = createExistingAgentSessionStoreTargetResolver(cfg, {
    isSameDatabasePath: createOpenClawAgentDatabasePathMatcher(),
  });
  function prepareDiscovery(params: GatewaySessionStoreLookupParams) {
    const identity = resolveSessionStoreIdentity({
      cfg,
      sessionKey: params.key,
      agentId: params.agentId,
      preserveQualifiedAddress: params.preserveQualifiedAddress,
    });
    if (isIncognitoSessionKey(identity.canonicalKey)) {
      return;
    }
    const agentIds = new Set([identity.agentId]);
    const parsed = parseAgentSessionKey(params.key);
    if (!params.preserveQualifiedAddress && parsed) {
      // Deleted-main lookup runs before request aliases and needs the original owner's stores.
      agentIds.add(normalizeAgentId(parsed.agentId));
    }
    for (const agentId of agentIds) {
      resolveGatewaySessionStoreCandidates(
        cfg,
        agentId,
        targetDiscoveryCache,
        false,
        params.env,
        resolveExistingTargets,
      );
    }
  }
  function readAlias(key: string, agentId: string) {
    const metadata = captureSessionEntryMetadataRead({ sessionKey: key, agentId }, () => {});
    if (metadata) {
      return metadata.readCurrent();
    }
    const params: GatewaySessionStoreLookupParams = {
      cfg,
      key,
      ...(parseAgentSessionKey(key) ? {} : { agentId }),
      readOnly: true,
      exactRead: true,
      clone: false,
      projection: "list",
      targetDiscoveryCache,
    };
    prepareDiscovery(params);
    const target = resolveNativeGatewaySessionStoreTargetWithStore(params);
    return target.store[target.canonicalKey];
  }
  const readStored = (agentId: string, key: string): SessionEntry | undefined => {
    if (isIncognitoSessionKey(key)) {
      return readAlias(key, agentId);
    }
    const params: GatewaySessionStoreLookupParams = {
      cfg,
      agentId,
      key,
      preserveQualifiedAddress: true,
      readOnly: true,
      exactRead: true,
      clone: false,
      projection: "list",
      targetDiscoveryCache,
    };
    prepareDiscovery(params);
    return resolveNativeGatewaySessionStoreTargetWithStore(params).store[key];
  };
  return { readStored, readAlias };
}

/** Exact row owners supply missing parent facts without expanding their selected store. */
export function createGatewaySessionEntryReader(params: {
  cfg: OpenClawConfig;
  agentId: string;
  store: Record<string, SessionEntry>;
  readSource?: SessionEntryReadSource;
}): (key: string) => SessionEntry | undefined {
  const reader = createGatewaySessionLineageReader(params.cfg);
  return (key) => {
    if (params.store[key]) {
      return params.store[key];
    }
    if (key === "global" || key === "unknown") {
      const readSource = params.readSource;
      if (!readSource) {
        return undefined;
      }
      return readGatewaySessionStore({
        agentId: readSource.agentId,
        storePath: readSource.path,
        options: { readSource, readOnly: true, exactKeys: [key], projection: "list" },
      })[key];
    }
    return selectStoredSessionLineage({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: key,
      read: reader.readStored,
      readAlias: () => reader.readAlias(key, params.agentId),
    }).value;
  };
}
