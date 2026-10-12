import { isIP } from "node:net";
import type {
  HostdRequest,
  HostdResult,
  SystemEthernetApplyTransaction,
  SystemEthernetConfig,
  SystemEthernetStatus,
  SystemEthernetUpdateInput
} from "@sigmaos/shared";
import { HostdClient, HostdRequestError } from "./hostd-client.js";
import { safeNetworkManagerMessage } from "./network-manager.js";

const HOSTD_TIMEOUT_MS = 120_000;

export interface EthernetManagerRuntime {
  getStatus(): Promise<SystemEthernetStatus>;
  save(deviceId: string, input: SystemEthernetUpdateInput): Promise<SystemEthernetStatus>;
  apply(confirmed: boolean): Promise<SystemEthernetApplyTransaction>;
  confirm(transactionId: string): Promise<SystemEthernetApplyTransaction>;
  rollback(transactionId: string): Promise<SystemEthernetApplyTransaction>;
}

export interface EthernetHostdClient {
  request<Request extends HostdRequest<"network.manager">>(
    payload: Request
  ): Promise<HostdResult<"network.manager", Request>>;
}

export class EthernetManagerRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly rollback: "not_required" | "succeeded" | "failed" = "not_required"
  ) {
    super(message);
    this.name = "EthernetManagerRequestError";
  }
}

class HostdEthernetClient implements EthernetHostdClient {
  private readonly client: HostdClient;

  constructor(socketPath: string) {
    this.client = new HostdClient(socketPath);
  }

  async request<Request extends HostdRequest<"network.manager">>(
    payload: Request
  ): Promise<HostdResult<"network.manager", Request>> {
    try {
      return await this.client.request("network.manager", payload, HOSTD_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof HostdRequestError) {
        const rollback = error.details.rollback;
        throw new EthernetManagerRequestError(
          safeNetworkManagerMessage(error),
          error.statusCode,
          rollback === "succeeded" || rollback === "failed" ? rollback : "not_required"
        );
      }
      throw new EthernetManagerRequestError("hostd is unavailable", 503);
    }
  }
}

export class SystemEthernetManagerRuntime implements EthernetManagerRuntime {
  private readonly hostd: EthernetHostdClient;

  constructor(socketPath: string, hostd?: EthernetHostdClient) {
    this.hostd = hostd ?? new HostdEthernetClient(socketPath);
  }

  async getStatus(): Promise<SystemEthernetStatus> {
    return this.hostd.request({ action: "ethernet_status" });
  }

  async save(deviceId: string, input: SystemEthernetUpdateInput): Promise<SystemEthernetStatus> {
    validateDeviceId(deviceId);
    validateEthernetUpdate(input);
    return this.hostd.request({ action: "ethernet_save", deviceId, input });
  }

  apply(confirmed: boolean): Promise<SystemEthernetApplyTransaction> {
    if (!confirmed) throw new EthernetManagerRequestError("Ethernet apply confirmation is required", 400);
    return this.hostd.request({ action: "ethernet_apply", confirmed });
  }

  confirm(transactionId: string): Promise<SystemEthernetApplyTransaction> {
    validateTransactionId(transactionId);
    return this.hostd.request({ action: "ethernet_confirm", transactionId });
  }

  rollback(transactionId: string): Promise<SystemEthernetApplyTransaction> {
    validateTransactionId(transactionId);
    return this.hostd.request({ action: "ethernet_rollback", transactionId });
  }
}

export function validateEthernetUpdate(input: SystemEthernetUpdateInput): void {
  if (!input || typeof input.expectedRevision !== "string" || !/^[0-9a-f]{64}$/u.test(input.expectedRevision)) {
    throw new EthernetManagerRequestError("A current Ethernet revision is required", 400);
  }
  validateEthernetConfig(input.config);
}

export function validateEthernetConfig(config: SystemEthernetConfig): void {
  if (!config || typeof config.enabled !== "boolean") {
    throw new EthernetManagerRequestError("Invalid Ethernet configuration", 400);
  }
  validateFamily(config.ipv4, 4);
  validateFamily(config.ipv6, 6);
}

function validateFamily(
  config: SystemEthernetConfig["ipv4"] | SystemEthernetConfig["ipv6"],
  family: 4 | 6
): void {
  const modes = family === 4 ? ["disabled", "dhcp", "static"] : ["disabled", "automatic", "static"];
  if (!config || !modes.includes(config.mode) || !["automatic", "manual"].includes(config.dnsMode)
    || typeof config.useDefaultRoute !== "boolean"
    || !Number.isInteger(config.routeMetric) || config.routeMetric < 1 || config.routeMetric > 65_535
    || !Array.isArray(config.dns) || config.dns.length > 3
    || config.dns.some((address) => typeof address !== "string")) {
    throw new EthernetManagerRequestError(`Invalid IPv${family} configuration`, 400);
  }
  const validAddress = (value: string | null): value is string => typeof value === "string" && isIP(value) === family;
  if (config.mode === "static") {
    if (!validAddress(config.address) || !Number.isInteger(config.prefixLength)
      || config.prefixLength! < 0 || config.prefixLength! > (family === 4 ? 32 : 128)) {
      throw new EthernetManagerRequestError(`Static IPv${family} requires a valid address and prefix`, 400);
    }
    if (config.gateway !== null && !validAddress(config.gateway)) {
      throw new EthernetManagerRequestError(`Static IPv${family} gateway has the wrong address family`, 400);
    }
    if (config.useDefaultRoute && config.gateway === null) {
      throw new EthernetManagerRequestError(`Static IPv${family} default route requires a gateway`, 400);
    }
  } else if (config.address !== null || config.prefixLength !== null || config.gateway !== null) {
    throw new EthernetManagerRequestError(`Automatic or disabled IPv${family} cannot include static values`, 400);
  }
  if (config.dns.some((address) => isIP(address) !== family)
    || (config.dnsMode === "automatic" && config.dns.length > 0)
    || (config.dnsMode === "manual" && config.dns.length === 0)) {
    throw new EthernetManagerRequestError(`Invalid IPv${family} DNS configuration`, 400);
  }
}

function validateDeviceId(value: string): void {
  if (!/^[0-9a-f]{12}$/u.test(value)) {
    throw new EthernetManagerRequestError("Invalid Ethernet device id", 400);
  }
}

function validateTransactionId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new EthernetManagerRequestError("Invalid Ethernet transaction id", 400);
  }
}
