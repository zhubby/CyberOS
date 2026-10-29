export const ISCSI_REFRESH_EVENT = "cyberos:iscsi-refresh";

export interface IscsiTargetForm {
  name: string;
  address: string;
  port: string;
  initiators: string;
  chapEnabled: boolean;
  username: string;
  password: string;
}

export function iscsiGiBToBytes(input: string): number | null {
  if (!/^[1-9]\d*$/u.test(input)) return null;
  const bytes = Number(input) * 1024 ** 3;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

export function parseIscsiInitiators(input: string): string[] {
  return [...new Set(input.split(/[\s,]+/u).map((value) => value.trim()).filter(Boolean))];
}

export type IscsiTargetValidationIssue = "name" | "address" | "port" | "initiators" | "username" | "password";

export function validateIscsiTarget(form: IscsiTargetForm, addresses: string[], keepPassword: boolean): IscsiTargetValidationIssue | null {
  if (!form.name.trim() || form.name.trim().length > 64 || [...form.name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return "name";
  if (!addresses.includes(form.address)) return "address";
  if (!/^\d+$/u.test(form.port) || Number(form.port) < 1 || Number(form.port) > 65535) return "port";
  const initiators = parseIscsiInitiators(form.initiators);
  if (!initiators.length || initiators.length > 64 || initiators.some((iqn) => iqn.length > 223 || !/^iqn\.\d{4}-(?:0[1-9]|1[0-2])\.[a-z0-9][a-z0-9.-]*(?::[a-z0-9._:-]+)?$/u.test(iqn))) return "initiators";
  if (form.chapEnabled) {
    if (!/^[!-~]{1,128}$/u.test(form.username)) return "username";
    if (!(keepPassword && !form.password) && !/^[\x20-\x7e]{12,16}$/u.test(form.password)) return "password";
  }
  return null;
}
