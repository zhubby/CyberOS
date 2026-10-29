import { describe, expect, it } from "vitest";
import { iscsiGiBToBytes, parseIscsiInitiators, validateIscsiTarget } from "./iscsi.js";

describe("iSCSI form validation", () => {
  it("accepts only safe positive whole GiB capacities", () => {
    expect(iscsiGiBToBytes("16")).toBe(16 * 1024 ** 3);
    for (const input of ["", "0", "-1", "1.5", "1e3", "99999999999999999", "NaN"]) expect(iscsiGiBToBytes(input)).toBeNull();
  });

  it("normalizes an explicit IQN whitelist without silently accepting invalid entries", () => {
    expect(parseIscsiInitiators("iqn.2026-10.local.test:one\n iqn.2026-10.local.test:two \n"))
      .toEqual(["iqn.2026-10.local.test:one", "iqn.2026-10.local.test:two"]);
    expect(parseIscsiInitiators(" ")).toEqual([]);
    expect(validateIscsiTarget({ name: "test", address: "192.168.1.2", port: "3260", initiators: "*", chapEnabled: false, username: "", password: "" }, ["192.168.1.2"], false)).toBe("initiators");
  });

  it("requires a current local address and CHAP credentials unless keeping an existing password", () => {
    const form = { name: "test", address: "192.168.1.2", port: "3260", initiators: "iqn.2026-10.local.test:one", chapEnabled: true, username: "client", password: "" };
    expect(validateIscsiTarget(form, ["192.168.1.2"], false)).toBe("password");
    expect(validateIscsiTarget(form, ["192.168.1.2"], true)).toBeNull();
    expect(validateIscsiTarget({ ...form, password: "twelve-bytes" }, [], false)).toBe("address");
    expect(validateIscsiTarget({ ...form, port: "3260.1" }, [form.address], true)).toBe("port");
  });
});
