import { CapabilityError, type CapabilityContext, type CapabilityDescriptor, type JsonValue } from "./contracts.js";

const CAPABILITY_ID = /^cyberos\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/u;

export class CapabilityRegistry {
  readonly #descriptors = new Map<string, CapabilityDescriptor>();

  register(descriptor: CapabilityDescriptor): this {
    if (!CAPABILITY_ID.test(descriptor.id)) {
      throw new Error(`Invalid capability id: ${descriptor.id}`);
    }
    if (this.#descriptors.has(descriptor.id)) {
      throw new Error(`Duplicate capability id: ${descriptor.id}`);
    }
    if (descriptor.inputSchema.type !== "object" || descriptor.inputSchema.additionalProperties !== false) {
      throw new Error(`Capability ${descriptor.id} must use a strict object input schema`);
    }
    if (descriptor.maxOutputBytes <= 0) {
      throw new Error(`Capability ${descriptor.id} must define a positive output limit`);
    }
    if (descriptor.approval === "none" && descriptor.risk !== "read") {
      throw new Error(`Mutating capability ${descriptor.id} must require first-party approval`);
    }
    if (descriptor.approval === "owner_control" && (descriptor.domain !== "runs" || descriptor.risk !== "low")) {
      throw new Error(`Capability ${descriptor.id} cannot use owner-controlled cancellation`);
    }
    this.#descriptors.set(descriptor.id, descriptor);
    return this;
  }

  get(id: string): CapabilityDescriptor | null {
    return this.#descriptors.get(id) ?? null;
  }

  list(): CapabilityDescriptor[] {
    return [...this.#descriptors.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  listForScopes(scopes: ReadonlySet<string>): CapabilityDescriptor[] {
    return this.list().filter((descriptor) => hasRequiredScopes(scopes, descriptor.requiredScopes));
  }

  async invoke(id: string, input: JsonValue, context: CapabilityContext) {
    const descriptor = this.get(id);
    if (!descriptor || !hasRequiredScopes(context.subject.scopes, descriptor.requiredScopes)) {
      throw new CapabilityError("FORBIDDEN", "Capability is not available to this client");
    }
    const availability = await descriptor.availability?.(context);
    if (availability && !availability.available) {
      throw new CapabilityError("NOT_READY", availability.reason ?? "Capability is not ready", { retryable: true });
    }
    if (!descriptor.execute) {
      throw new CapabilityError("NOT_READY", "Capability adapter is not installed", { retryable: true });
    }
    const execution = await descriptor.execute(input, context);
    const outputBytes = Buffer.byteLength(JSON.stringify(execution), "utf8");
    if (outputBytes > descriptor.maxOutputBytes) {
      throw new CapabilityError(
        "INTERNAL",
        `Capability output exceeded its ${descriptor.maxOutputBytes} byte limit`
      );
    }
    return execution;
  }
}

export function hasRequiredScopes(granted: ReadonlySet<string>, required: readonly string[]): boolean {
  return required.every((scope) => granted.has(scope));
}
